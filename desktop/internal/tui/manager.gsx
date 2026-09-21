// Package tui is the terminal front end of WhiteSoft: a go-tui manager for a
// library of `.note` boards.
//
// It browses boards and pages, inspects what they contain (ink, images, PDF
// backdrops, text and LaTeX source) and can start the project's web UI for a
// board.  Everything here is read-only: boards are never modified from the
// terminal.
package tui

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	tui "github.com/grindlemire/go-tui"

	"github.com/cutx64/WhiteSoft/desktop/internal/launcher"
	"github.com/cutx64/WhiteSoft/desktop/internal/notes"
)

// Options configures the manager.
type Options struct {
	Root   string // workspace directory holding the .note files
	Server string // path to server.mjs ("" = auto-detect)
	Node   string // node executable ("" = auto-detect)
	Port   int    // 0 = pick a free port when the server starts
	Open   bool   // open the browser as soon as the server is up
}

type manager struct {
	opts Options

	boards  *tui.State[[]notes.Board]
	detail  *tui.State[*notes.Detail]
	status  *tui.State[string]
	busy    *tui.State[string]
	serverUp *tui.State[bool]
	url     *tui.State[string]

	boardCur  *tui.State[int]
	pageCur   *tui.State[int]
	focus     *tui.State[int] // 0 = board list, 1 = page list
	filter    *tui.State[string]
	filtering *tui.State[bool]
	showAll   *tui.State[bool] // preview every text block of a page

	boardScroll *tui.State[int]
	pageScroll  *tui.State[int]
	boardRef    *tui.Ref
	pageRef     *tui.Ref

	srv     *launcher.Server
	loading bool
}

// Manager creates the terminal manager component.
func Manager(opts Options) *manager {
	m := &manager{
		opts:        opts,
		boards:      tui.NewState([]notes.Board{}),
		detail:      tui.NewState[*notes.Detail](nil),
		status:      tui.NewState(""),
		busy:        tui.NewState(""),
		serverUp:    tui.NewState(false),
		url:         tui.NewState(""),
		boardCur:    tui.NewState(0),
		pageCur:     tui.NewState(0),
		focus:       tui.NewState(0),
		filter:      tui.NewState(""),
		filtering:   tui.NewState(false),
		showAll:     tui.NewState(false),
		boardScroll: tui.NewState(0),
		pageScroll:  tui.NewState(0),
		boardRef:    tui.NewRef(),
		pageRef:     tui.NewRef(),
	}
	m.rescan()
	return m
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

func (m *manager) rescan() {
	boards, err := notes.Scan(m.opts.Root)
	if err != nil {
		m.status.Set("扫描工作区失败：" + err.Error())
		return
	}
	m.boards.Set(boards)
	m.boardCur.Set(0)
	m.boardScroll.Set(0)
	m.detail.Set(nil)
	m.pageCur.Set(0)
	if len(boards) == 0 {
		m.status.Set("该目录下没有 .note 文件（可用网页端导入 PDF 新建）")
	} else {
		m.status.Set(fmt.Sprintf("发现 %d 个白板", len(boards)))
	}
}

func (m *manager) visibleBoards() []notes.Board {
	all := m.boards.Get()
	q := strings.ToLower(strings.TrimSpace(m.filter.Get()))
	if q == "" {
		return all
	}
	var out []notes.Board
	for _, b := range all {
		if strings.Contains(strings.ToLower(b.Name), q) {
			out = append(out, b)
		}
	}
	return out
}

// visiblePages hides pages that do not match the filter (content search).
func (m *manager) visiblePages() []notes.Page {
	d := m.detail.Get()
	if d == nil {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(m.filter.Get()))
	if q == "" {
		return d.Pages
	}
	var out []notes.Page
	for _, p := range d.Pages {
		if strings.Contains(strings.ToLower(pageHaystack(p)), q) {
			out = append(out, p)
		}
	}
	return out
}

func pageHaystack(p notes.Page) string {
	var b strings.Builder
	for _, t := range p.Texts {
		b.WriteString(t)
		b.WriteByte('\n')
	}
	return b.String()
}

func (m *manager) selectedBoard() *notes.Board {
	list := m.visibleBoards()
	i := m.boardCur.Get()
	if i < 0 || i >= len(list) {
		return nil
	}
	return &list[i]
}

func (m *manager) selectedPage() *notes.Page {
	list := m.visiblePages()
	i := m.pageCur.Get()
	if i < 0 || i >= len(list) {
		return nil
	}
	return &list[i]
}

/* ------------------------------------------------------------------ *
 * Loading a board
 * ------------------------------------------------------------------ */

func (m *manager) loadSelectedBoard(app *tui.App) {
	b := m.selectedBoard()
	if b == nil || m.loading {
		return
	}
	name, path := b.Name, b.Path
	m.loading = true
	m.busy.Set("正在载入 " + name + " …")
	go func() {
		d, err := notes.Load(path, func(done, total int) {
			app.QueueUpdate(func() {
				m.busy.Set(fmt.Sprintf("正在载入 %s … %d/%d 页", name, done, total))
			})
		})
		app.QueueUpdate(func() {
			m.loading = false
			if err != nil {
				m.busy.Set("载入失败：" + err.Error())
				return
			}
			m.detail.Set(d)
			m.pageCur.Set(0)
			m.pageScroll.Set(0)
			_, _, _, texts, withContent := d.Stats()
			m.busy.Set(fmt.Sprintf("%s：%d 页，其中 %d 页有内容，%d 段文字",
				d.Name, len(d.Pages), withContent, texts))
		})
	}()
}

/* ------------------------------------------------------------------ *
 * The web UI
 * ------------------------------------------------------------------ */

func (m *manager) toggleServer(app *tui.App, open bool) {
	if m.srv != nil {
		if open {
			url := m.url.Get()
			if err := launcher.OpenBrowser(url); err != nil {
				m.status.Set("打开浏览器失败：" + err.Error())
			} else {
				m.status.Set("已在浏览器打开 " + url)
			}
			return
		}
		srv := m.srv
		m.srv = nil
		m.serverUp.Set(false)
		m.url.Set("")
		m.status.Set("正在停止服务 …")
		go func() {
			_ = srv.Stop()
			app.QueueUpdate(func() { m.status.Set("服务已停止") })
		}()
		return
	}

	cfg := launcher.Config{
		Root:     m.opts.Root,
		ServerJS: m.opts.Server,
		NodeBin:  m.opts.Node,
		Port:     m.opts.Port,
	}
	m.status.Set("正在启动 server.mjs …")
	go func() {
		srv, err := launcher.Start(context.Background(), cfg)
		app.QueueUpdate(func() {
			if err != nil {
				m.status.Set("启动失败：" + err.Error())
				return
			}
			m.srv = srv
			m.url.Set(srv.URL())
			m.serverUp.Set(true)
			m.status.Set("服务已启动 " + srv.URL())
			if open {
				if err := launcher.OpenBrowser(srv.URL()); err != nil {
					m.status.Set("服务已启动，但打开浏览器失败：" + err.Error())
				}
			}
		})
	}()
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

func (m *manager) move(delta int) {
	if m.focus.Get() == 0 {
		n := len(m.visibleBoards())
		m.boardCur.Update(func(v int) int { return clampInt(v+delta, 0, n-1) })
		return
	}
	n := len(m.visiblePages())
	m.pageCur.Update(func(v int) int { return clampInt(v+delta, 0, n-1) })
}

func (m *manager) scrollToCursor() {
	var ref *tui.Ref
	var cur, scroll *tui.State[int]
	if m.focus.Get() == 0 {
		ref, cur, scroll = m.boardRef, m.boardCur, m.boardScroll
	} else {
		ref, cur, scroll = m.pageRef, m.pageCur, m.pageScroll
	}
	el := ref.El()
	if el == nil {
		return
	}
	_, vpH := el.ViewportSize()
	if vpH <= 0 {
		return
	}
	y := scroll.Get()
	c := cur.Get()
	if c < y {
		scroll.Set(c)
	} else if c >= y+vpH {
		scroll.Set(c - vpH + 1)
	}
}

// Watchers keeps the highlighted row on screen as the cursor moves.
func (m *manager) Watchers() []tui.Watcher {
	return []tui.Watcher{
		tui.OnChange(m.boardCur, func(int) { m.scrollToCursor() }),
		tui.OnChange(m.pageCur, func(int) { m.scrollToCursor() }),
		tui.OnChange(m.focus, func(int) { m.scrollToCursor() }),
	}
}

const helpLine = "j/k 移动 · tab 切换栏位 · enter 载入 / 浏览器打开 · o 打开 · s 服务 · / 搜索 · a 展开 · r 刷新 · q 退出"

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

func (m *manager) KeyMap() tui.KeyMap {
	quit := func(ke tui.KeyEvent) { ke.App().Stop() }
	return tui.KeyMap{
		tui.OnStop(tui.KeyCtrlC, quit),
		tui.OnStop(tui.Rune('q'), func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.typeRune('q')
				return
			}
			quit(ke)
		}),
		tui.OnStop(tui.KeyTab, func(ke tui.KeyEvent) {
			m.focus.Update(func(v int) int { return 1 - v })
			m.scrollToCursor()
		}),
		tui.OnStop(tui.KeyUp, func(ke tui.KeyEvent) { m.move(-1) }),
		tui.OnStop(tui.KeyDown, func(ke tui.KeyEvent) { m.move(1) }),
		tui.OnStop(tui.Rune('k'), func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.typeRune('k')
				return
			}
			m.move(-1)
		}),
		tui.OnStop(tui.Rune('j'), func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.typeRune('j')
				return
			}
			m.move(1)
		}),
		tui.OnStop(tui.KeyLeft, func(ke tui.KeyEvent) { m.focus.Set(0) }),
		tui.OnStop(tui.KeyRight, func(ke tui.KeyEvent) { m.focus.Set(1) }),
		tui.OnStop(tui.KeyEnter, func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.filtering.Set(false)
				return
			}
			if m.focus.Get() == 0 {
				m.loadSelectedBoard(ke.App())
				return
			}
			m.toggleServer(ke.App(), true)
		}),
		tui.OnStop(tui.KeyEscape, func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.filtering.Set(false)
				m.filter.Set("")
				m.boardCur.Set(0)
				m.pageCur.Set(0)
				return
			}
			if m.filter.Get() != "" {
				m.filter.Set("")
				return
			}
			ke.App().Stop()
		}),
		tui.OnStop(tui.Rune('/'), func(ke tui.KeyEvent) {
			m.filtering.Set(true)
			m.focus.Set(0)
		}),
		tui.OnStop(tui.KeyBackspace, func(ke tui.KeyEvent) {
			if !m.filtering.Get() {
				return
			}
			f := m.filter.Get()
			if f == "" {
				return
			}
			r := []rune(f)
			m.applyFilter(string(r[:len(r)-1]))
		}),
		tui.OnStop(tui.Rune('r'), func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.typeRune('r')
				return
			}
			m.rescan()
		}),
		tui.OnStop(tui.Rune('s'), func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.typeRune('s')
				return
			}
			m.toggleServer(ke.App(), false)
		}),
		tui.OnStop(tui.Rune('o'), func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.typeRune('o')
				return
			}
			m.toggleServer(ke.App(), true)
		}),
		tui.OnStop(tui.Rune('a'), func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.typeRune('a')
				return
			}
			m.showAll.Set(!m.showAll.Get())
		}),
		tui.OnStop(tui.AnyRune, func(ke tui.KeyEvent) {
			if m.filtering.Get() {
				m.typeRune(ke.Char())
			}
		}),
	}
}

func (m *manager) typeRune(r rune) {
	if r == 0 {
		return
	}
	m.applyFilter(m.filter.Get() + string(r))
}

func (m *manager) applyFilter(f string) {
	m.filter.Set(f)
	m.boardCur.Set(0)
	m.pageCur.Set(0)
	m.boardScroll.Set(0)
	m.pageScroll.Set(0)
}

/* ------------------------------------------------------------------ *
 * View helpers
 * ------------------------------------------------------------------ */

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 3; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}

func boardSubtitle(b notes.Board) string {
	parts := []string{fmt.Sprintf("%d 页", b.PageCount)}
	if b.Images > 0 {
		parts = append(parts, fmt.Sprintf("%d 图", b.Images))
	}
	if b.HasPDF {
		parts = append(parts, "PDF")
	}
	parts = append(parts, humanSize(b.Size))
	return strings.Join(parts, " · ")
}

func typeBreakdown(p notes.Page) string {
	type kv struct {
		t int
		n int
	}
	list := make([]kv, 0, len(p.Types))
	for t, n := range p.Types {
		list = append(list, kv{t, n})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].n > list[j].n })
	var parts []string
	for i, e := range list {
		if i >= 5 {
			break
		}
		parts = append(parts, fmt.Sprintf("%s×%d", notes.TypeName(e.t), e.n))
	}
	return strings.Join(parts, " ")
}

func pageTitle(p notes.Page) string {
	flags := []string{fmt.Sprintf("%d 元素", p.Elements)}
	if p.Ink > 0 {
		flags = append(flags, fmt.Sprintf("%d 墨迹点", p.Ink))
	}
	if p.Images > 0 {
		flags = append(flags, fmt.Sprintf("%d 图", p.Images))
	}
	if p.HasPDF {
		flags = append(flags, "PDF 背景")
	}
	return fmt.Sprintf("第 %d 页 · %s", p.Number, strings.Join(flags, " · "))
}

// previewLines returns the text blocks to show for a page.
func (m *manager) previewLines(p notes.Page) []string {
	max := 4
	if m.showAll.Get() {
		max = 40
	}
	var out []string
	for i, t := range p.Texts {
		if i >= max {
			out = append(out, fmt.Sprintf("… 还有 %d 段", len(p.Texts)-max))
			break
		}
		out = append(out, t)
	}
	if len(out) == 0 {
		out = append(out, "（这一页没有文字内容）")
	}
	return out
}

func containsMath(p notes.Page) bool {
	for _, t := range p.Texts {
		if strings.Contains(t, "$") {
			return true
		}
	}
	return false
}

func clampInt(v, lo, hi int) int {
	if hi < lo {
		return lo
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func baseName(p string) string { return filepath.Base(p) }

// line builds a whole row of text.  go-tui lays text fragments out as flex
// items, so a row that mixes literals and interpolations must reach the
// template as a single string.
func line(indent int, s string) string { return strings.Repeat(" ", indent) + s }

func (m *manager) boardRow(i int, b notes.Board) string {
	if m.focus.Get() == 0 && i == m.boardCur.Get() {
		return "  ▶ " + b.Name
	}
	return "    " + b.Name
}

func (m *manager) pageRow(i int, p notes.Page) string {
	if m.focus.Get() == 1 && i == m.pageCur.Get() {
		return "  ▶ " + pageTitle(p)
	}
	return "    " + pageTitle(p)
}

func (m *manager) boardHeadline(d *notes.Detail) string {
	sub := "  " + boardSubtitle(d.Board) + m.pdfLabel(d)
	return sub
}

func (m *manager) serverLabel() string {
	if m.serverUp.Get() {
		return "服务 " + m.url.Get()
	}
	return "服务未启动（s 启动）"
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

templ (m *manager) Render() {
	boards := m.visibleBoards()
	detail := m.detail.Get()
	pages := m.visiblePages()
	page := m.selectedPage()
	<div class="flex-col w-full h-full border-rounded border-cyan">
		<div class="flex justify-between p-1">
			<span class="text-gradient-cyan-magenta font-bold">WhiteSoft 终端管理器</span>
			<span class="font-dim">{baseName(m.opts.Root)}</span>
			if m.serverUp.Get() {
				<span class="text-green">{line(0, m.serverLabel())}</span>
			} else {
				<span class="font-dim">{line(0, m.serverLabel())}</span>
			}
		</div>
		if m.status.Get() != "" {
			<span class="font-dim">{line(2, m.status.Get())}</span>
		}
		if m.busy.Get() != "" {
			<span class="text-yellow">{line(2, m.busy.Get())}</span>
		}
		if m.filtering.Get() || m.filter.Get() != "" {
			<span class="text-cyan">{fmt.Sprintf("  筛选：%s▌", m.filter.Get())}</span>
		}
		<hr class="border-single" />
		<div class="flex grow">
			<div class="flex-col w-40 border-rounded border-black">
				<span class="font-bold">{fmt.Sprintf("  白板（%d）", len(boards))}</span>
				<div
					ref={m.boardRef}
					class="flex-col grow overflow-y-scroll scrollbar-cyan scrollbar-thumb-bright-cyan"
					scrollOffset={0, m.boardScroll.Get()}>
					if len(boards) == 0 {
						<span class="font-dim">   （没有匹配的白板）</span>
					}
					for i, b := range boards {
						if m.focus.Get() == 0 && i == m.boardCur.Get() {
							<span class="bg-bright-black text-cyan font-bold">{m.boardRow(i, b)}</span>
						} else {
							<span>{m.boardRow(i, b)}</span>
						}
						if b.Err != "" {
							<span class="text-red">{line(6, b.Err)}</span>
						} else {
							<span class="font-dim">{line(6, boardSubtitle(b))}</span>
						}
					}
				</div>
			</div>
			<div class="flex-col grow">
				if detail == nil {
					<span class="font-dim">{line(2, "选中一个白板后按 enter 载入页列表。")}</span>
					<span class="font-dim">{line(2, "载入只读取 .note，不会修改文件。")}</span>
				} else {
					<span class="font-bold">{line(2, detail.Name)}</span>
					<span class="font-dim">{m.boardHeadline(detail)}</span>
					if detail.HasMath() {
						<span class="text-magenta">{line(2, "含 LaTeX 公式源码")}</span>
					}
					<hr class="border-single" />
					if page != nil {
						<span class="text-cyan">{line(2, pageTitle(*page))}</span>
						<span class="font-dim">{line(2, typeBreakdown(*page))}</span>
						if containsMath(*page) {
							<span class="text-magenta">{line(2, "这一页含公式")}</span>
						}
						for _, l := range m.previewLines(*page) {
							<span>{line(4, l)}</span>
						}
						<hr class="border-single" />
					}
					<div
						ref={m.pageRef}
						class="flex-col grow overflow-y-scroll scrollbar-cyan scrollbar-thumb-bright-cyan"
						scrollOffset={0, m.pageScroll.Get()}>
						if len(pages) == 0 {
							<span class="font-dim">   （没有匹配的画纸）</span>
						}
						for i, p := range pages {
							if m.focus.Get() == 1 && i == m.pageCur.Get() {
								<span class="bg-bright-black text-cyan font-bold">{m.pageRow(i, p)}</span>
							} else {
								<span class="font-dim">{m.pageRow(i, p)}</span>
							}
						}
					</div>
				}
			</div>
		</div>
		<hr class="border-single" />
		<div class="flex justify-center p-1">
			<span class="font-dim">{helpLine}</span>
		</div>
	</div>
}

// pdfLabel appends the embedded PDF's name when there is one.
func (m *manager) pdfLabel(d *notes.Detail) string {
	if d == nil || !d.HasPDF {
		return ""
	}
	if d.PDFName == "" {
		return " · 内嵌 PDF"
	}
	return " · 内嵌 " + d.PDFName
}
