// Package notes reads Microsoft Whiteboard `.note` archives.
//
// A `.note` file is a plain ZIP container holding `manifest.json`,
// `Pages/pageN.json` and `Resources/...`.  This package only ever *reads*:
// the desktop app inspects a library of boards without touching them, and
// every write still goes through the project's own server, so the
// non-destructive save rules live in exactly one place.
package notes

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Element type codes, as stored in `Pages/pageN.json`.
const (
	TypeInk         = 100001
	TypeHighlighter = 100005
	TypeLine        = 200002
	TypeRect        = 200003
	TypeEllipse     = 200004
	TypeArrow       = 200015
	TypePolyline    = 200017
	TypeImage       = 300001
	TypeText        = 300002
	TypeSticky      = 400001
	TypeTable       = 400002
	TypeReaction    = 400003
)

var typeNames = map[int]string{
	TypeInk:         "墨迹",
	TypeHighlighter: "荧光笔",
	TypeLine:        "直线",
	TypeRect:        "矩形",
	TypeEllipse:     "椭圆",
	TypeArrow:       "箭头",
	TypePolyline:    "折线",
	TypeImage:       "图片",
	TypeText:        "文本",
	TypeSticky:      "便签",
	TypeTable:       "表格",
	TypeReaction:    "反应",
	200005:          "三角形",
	200006:          "菱形",
	200007:          "五边形",
	200008:          "六边形",
	200009:          "五角星",
	200010:          "平行四边形",
	200011:          "块状箭头",
	200016:          "双箭头",
}

// TypeName labels an element type for the UI.
func TypeName(t int) string {
	if n, ok := typeNames[t]; ok {
		return n
	}
	return fmt.Sprintf("类型 %d", t)
}

// Board is the cheap summary shown in the board list: it needs nothing but the
// ZIP central directory plus `manifest.json`.
type Board struct {
	Path      string
	Name      string
	Size      int64
	ModTime   time.Time
	PageCount int
	Images    int
	HasPDF    bool
	PDFName   string
	Created   string
	Err       string
}

// Page summarises one `Pages/pageN.json`.
type Page struct {
	Number   int
	Elements int
	Ink      int // pen/highlighter points
	Images   int
	Texts    []string
	Types    map[int]int
	HasPDF   bool
	Scale    float64
	Drawn    bool // page carries any element at all
}

// Detail is a fully parsed board.
type Detail struct {
	Board
	Pages []Page
}

// Stats aggregates everything worth showing about a board.
func (d *Detail) Stats() (elements, ink, images, texts int, withContent int) {
	for _, p := range d.Pages {
		elements += p.Elements
		ink += p.Ink
		images += p.Images
		texts += len(p.Texts)
		if p.Elements > 0 {
			withContent++
		}
	}
	return
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

type manifest struct {
	Pages       []struct{ FileName string } `json:"pages"`
	CurrentPage int                         `json:"currentPage"`
	CreateTime  string                      `json:"createTime"`
	Document    *struct{ FileName string }  `json:"document"`
}

type element struct {
	Type     int               `json:"type"`
	Text     string            `json:"text"`
	FileName string            `json:"fileName"`
	Inks     []json.RawMessage `json:"inks"`
	Points   []json.RawMessage `json:"points"`
	Cells    [][]string        `json:"cells"`
	Emoji    string            `json:"emoji"`
}

type pageJSON struct {
	Elements []element         `json:"elements"`
	Scale    float64           `json:"scale"`
	PDFPages []json.RawMessage `json:"pdfPages"`
}

// Scan lists every `.note` board under root (up to three levels deep) with its
// summary metadata.  Unreadable archives are reported per board rather than
// failing the whole scan.
func Scan(root string) ([]Board, error) {
	var out []Board
	seen := 0
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable subtree: skip it
		}
		if d.IsDir() {
			name := d.Name()
			if p != root && (strings.HasPrefix(name, ".") || name == "node_modules" || name == ".cache") {
				return filepath.SkipDir
			}
			if rel, relErr := filepath.Rel(root, p); relErr == nil && strings.Count(rel, string(os.PathSeparator)) >= 3 {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(p), ".note") {
			return nil
		}
		seen++
		out = append(out, describe(p))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// describe reads just enough of the archive to summarise it.
func describe(path string) Board {
	b := Board{Path: path, Name: strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))}
	if st, err := os.Stat(path); err == nil {
		b.Size = st.Size()
		b.ModTime = st.ModTime()
	}

	zr, err := zip.OpenReader(path)
	if err != nil {
		b.Err = "无法打开：不是有效的 ZIP"
		return b
	}
	defer zr.Close()

	for _, f := range zr.File {
		switch {
		case f.Name == "manifest.json":
			if rc, err := f.Open(); err == nil {
				data, _ := io.ReadAll(io.LimitReader(rc, 4<<20))
				rc.Close()
				var m manifest
				if json.Unmarshal(data, &m) == nil {
					b.PageCount = len(m.Pages)
					b.Created = m.CreateTime
					if m.Document != nil && m.Document.FileName != "" {
						b.HasPDF = true
						b.PDFName = m.Document.FileName
					}
				}
			}
		case strings.HasPrefix(f.Name, "Resources/Images/"):
			b.Images++
		case strings.HasPrefix(f.Name, "Resources/Document/"):
			b.HasPDF = true
			if b.PDFName == "" {
				b.PDFName = filepath.Base(f.Name)
			}
		}
	}
	if b.PageCount == 0 {
		// No usable manifest page list: fall back to counting page files.
		for _, f := range zr.File {
			if strings.HasPrefix(f.Name, "Pages/") && strings.HasSuffix(f.Name, ".json") {
				b.PageCount++
			}
		}
	}
	return b
}

// Load parses every page of a board.  `progress` (optional) is called with the
// number of pages decoded so far, which is what a 400-page board needs to keep
// the UI honest.
func Load(path string, progress func(done, total int)) (*Detail, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("打开 .note：%w", err)
	}
	defer zr.Close()

	d := &Detail{Board: describe(path)}
	if d.Err != "" {
		return nil, fmt.Errorf("%s", d.Err)
	}

	byName := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		byName[f.Name] = f
	}

	// Page order comes from the manifest; anything unreferenced is appended.
	var order []string
	if f := byName["manifest.json"]; f != nil {
		if rc, err := f.Open(); err == nil {
			data, _ := io.ReadAll(io.LimitReader(rc, 4<<20))
			rc.Close()
			var m manifest
			if json.Unmarshal(data, &m) == nil {
				for _, p := range m.Pages {
					if p.FileName != "" {
						order = append(order, "Pages/"+strings.TrimPrefix(p.FileName, "Pages/"))
					}
				}
			}
		}
	}
	if len(order) == 0 {
		for _, f := range zr.File {
			if strings.HasPrefix(f.Name, "Pages/") && strings.HasSuffix(f.Name, ".json") {
				order = append(order, f.Name)
			}
		}
		sort.Strings(order)
	}
	d.Board.PageCount = len(order)

	total := len(order)
	for i, name := range order {
		p := Page{Number: i + 1, Types: map[int]int{}}
		if f := byName[name]; f != nil {
			if rc, err := f.Open(); err == nil {
				data, err := io.ReadAll(rc)
				rc.Close()
				if err == nil {
					fillPage(&p, data)
				}
			}
		}
		d.Pages = append(d.Pages, p)
		if progress != nil && (i%16 == 0 || i == total-1) {
			progress(i+1, total)
		}
	}
	return d, nil
}

func fillPage(p *Page, data []byte) {
	var pj pageJSON
	if err := json.Unmarshal(data, &pj); err != nil {
		return
	}
	p.Scale = pj.Scale
	p.HasPDF = len(pj.PDFPages) > 0
	p.Elements = len(pj.Elements)
	for _, e := range pj.Elements {
		p.Types[e.Type]++
		switch e.Type {
		case TypeInk, TypeHighlighter:
			p.Ink += len(e.Inks) + len(e.Points)
		case TypeImage:
			p.Images++
		case TypeText, TypeSticky:
			if t := cleanText(e.Text); t != "" {
				p.Texts = append(p.Texts, t)
			}
		case TypeTable:
			for _, row := range e.Cells {
				for _, cell := range row {
					if t := cleanText(cell); t != "" {
						p.Texts = append(p.Texts, t)
					}
				}
			}
		case TypeReaction:
			if e.Emoji != "" {
				p.Texts = append(p.Texts, e.Emoji)
			}
		}
	}
	p.Drawn = p.Elements > 0
}

// cleanText flattens a stored string for previewing / searching.
func cleanText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "\n", " ⏎ ")
	r := []rune(s)
	if len(r) > 200 {
		return string(r[:200]) + "…"
	}
	return s
}

// Search returns the pages of a board whose text matches query
// (case-insensitive substring match).
func (d *Detail) Search(query string) []Page {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	var hits []Page
	for _, p := range d.Pages {
		for _, t := range p.Texts {
			if strings.Contains(strings.ToLower(t), q) {
				hits = append(hits, p)
				break
			}
		}
	}
	return hits
}

// HasMath reports whether any page of the board carries LaTeX source.
func (d *Detail) HasMath() bool {
	for _, p := range d.Pages {
		for _, t := range p.Texts {
			if strings.Contains(t, "$") {
				return true
			}
		}
	}
	return false
}
