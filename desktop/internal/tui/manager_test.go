package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cutx64/WhiteSoft/desktop/internal/notes"
)

// The manager's states work without a running App, so the list/filter logic is
// testable directly.  (The rendered tree itself is exercised by driving the
// binary in a real PTY — see the project README.)
func newTestManager(t *testing.T) *manager {
	t.Helper()
	root := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.note", "not a zip") // shows up with an error, must not break the list
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := Manager(Options{Root: root})
	return m
}

func TestManagerScans(t *testing.T) {
	m := newTestManager(t)
	boards := m.boards.Get()
	if len(boards) != 1 {
		t.Fatalf("boards = %d, want 1", len(boards))
	}
	if boards[0].Err == "" {
		t.Error("a non-ZIP .note should be reported with an error, not crash the scan")
	}
	if !strings.Contains(m.status.Get(), "1 个白板") {
		t.Errorf("status = %q", m.status.Get())
	}
}

func TestFilterBoards(t *testing.T) {
	m := newTestManager(t)
	m.boards.Set([]notes.Board{
		{Name: "Al-jabr-1", PageCount: 446},
		{Name: "Al-jabr-2", PageCount: 655},
		{Name: "lecture", PageCount: 3},
	})
	if got := len(m.visibleBoards()); got != 3 {
		t.Fatalf("unfiltered = %d", got)
	}
	m.applyFilter("jabr")
	if got := len(m.visibleBoards()); got != 2 {
		t.Fatalf("filtered = %d, want 2", got)
	}
	m.applyFilter("LECTURE")
	if got := len(m.visibleBoards()); got != 1 {
		t.Fatalf("case-insensitive filter = %d, want 1", got)
	}
	m.applyFilter("")
	if got := len(m.visibleBoards()); got != 3 {
		t.Fatalf("cleared filter = %d", got)
	}
	if m.selectedBoard() == nil || m.selectedBoard().Name != "Al-jabr-1" {
		t.Errorf("selection = %+v", m.selectedBoard())
	}
}

func TestFilterPagesByContent(t *testing.T) {
	m := newTestManager(t)
	m.detail.Set(&notes.Detail{
		Board: notes.Board{Name: "b", PageCount: 3},
		Pages: []notes.Page{
			{Number: 1, Elements: 3, Ink: 100, Texts: []string{"便签 $x^2$"}},
			{Number: 2, Elements: 0},
			{Number: 3, Elements: 1, Texts: []string{"\\sqrt{a}"}},
		},
	})
	if got := len(m.visiblePages()); got != 3 {
		t.Fatalf("unfiltered pages = %d", got)
	}
	m.applyFilter("sqrt")
	pages := m.visiblePages()
	if len(pages) != 1 || pages[0].Number != 3 {
		t.Fatalf("filtered pages = %+v", pages)
	}
	if p := m.selectedPage(); p == nil || p.Number != 3 {
		t.Fatalf("selected page = %+v", p)
	}
	// page numbers keep referring to the board's own numbering
	m.applyFilter("")
	if p := m.selectedPage(); p == nil || p.Number != 1 {
		t.Fatalf("selection after clearing = %+v", p)
	}
}

func TestMoveKeepsCursorInRange(t *testing.T) {
	m := newTestManager(t)
	m.boards.Set([]notes.Board{{Name: "a"}, {Name: "b"}})
	m.focus.Set(0)
	m.move(-1)
	if got := m.boardCur.Get(); got != 0 {
		t.Errorf("cursor moved above the list: %d", got)
	}
	m.move(1)
	if got := m.boardCur.Get(); got != 1 {
		t.Errorf("cursor = %d, want 1", got)
	}
	m.move(5)
	if got := m.boardCur.Get(); got != 1 {
		t.Errorf("cursor ran past the end: %d", got)
	}
}

func TestFormattingHelpers(t *testing.T) {
	if got := humanSize(512); got != "512 B" {
		t.Errorf("humanSize(512) = %q", got)
	}
	if got := humanSize(334_8 << 20 / 10); !strings.HasSuffix(got, "MB") {
		t.Errorf("humanSize(mb) = %q", got)
	}
	b := notes.Board{Name: "x", PageCount: 446, Images: 1428, HasPDF: true, Size: 351_020_009}
	sub := boardSubtitle(b)
	for _, want := range []string{"446 页", "1428 图", "PDF", "MB"} {
		if !strings.Contains(sub, want) {
			t.Errorf("subtitle %q missing %q", sub, want)
		}
	}
	p := notes.Page{Number: 7, Elements: 12, Ink: 186_000, Images: 3, HasPDF: true, Types: map[int]int{notes.TypeInk: 10, notes.TypeText: 2}}
	title := pageTitle(p)
	for _, want := range []string{"第 7 页", "12 元素", "186000 墨迹点", "3 图", "PDF 背景"} {
		if !strings.Contains(title, want) {
			t.Errorf("pageTitle %q missing %q", title, want)
		}
	}
	if br := typeBreakdown(p); !strings.Contains(br, "墨迹×10") || !strings.Contains(br, "文本×2") {
		t.Errorf("typeBreakdown = %q", br)
	}
	if got := line(4, "x"); got != "    x" {
		t.Errorf("line = %q", got)
	}
	if !containsMath(notes.Page{Texts: []string{"$x$"}}) || containsMath(notes.Page{Texts: []string{"plain"}}) {
		t.Error("containsMath is wrong")
	}
}

func TestPreviewLinesLimitsOutput(t *testing.T) {
	m := newTestManager(t)
	m.showAll.Set(false)
	p := notes.Page{Texts: []string{"1", "2", "3", "4", "5", "6", "7"}}
	got := m.previewLines(p)
	if len(got) != 5 || !strings.Contains(got[4], "还有 3 段") {
		t.Errorf("preview = %v", got)
	}
	m.showAll.Set(true)
	if got := m.previewLines(p); len(got) != 7 {
		t.Errorf("expanded preview = %v", got)
	}
	if got := m.previewLines(notes.Page{}); len(got) != 1 || !strings.Contains(got[0], "没有文字内容") {
		t.Errorf("empty preview = %v", got)
	}
}

func TestServerLabel(t *testing.T) {
	m := newTestManager(t)
	if got := m.serverLabel(); !strings.Contains(got, "未启动") {
		t.Errorf("label = %q", got)
	}
	m.serverUp.Set(true)
	m.url.Set("http://127.0.0.1:8787/")
	if got := m.serverLabel(); !strings.Contains(got, "8787") {
		t.Errorf("label = %q", got)
	}
}
