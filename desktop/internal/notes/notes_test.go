package notes

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeNote builds a small but realistic `.note` archive: a manifest, two
// pages (one with ink + a sticky holding LaTeX, one with an image) and an
// embedded PDF resource.
func writeNote(t *testing.T, path string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	add := func(name, body string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}

	add("manifest.json", `{
		"id": "3f1c0b7a-9d24-4c6e-8a51-0f2b7c9e4d18",
		"version": "1.0.0",
		"screenWidthPixels": 2880,
		"screenHeightPixels": 1920,
		"screenScale": 2,
		"pages": [{"fileName": "page1.json"}, {"fileName": "page2.json"}],
		"currentPage": 2,
		"createTime": "2026-09-18 20:31:00",
		"document": {"fileName": "textbook.pdf"}
	}`)
	add("Pages/page1.json", `{
		"scale": 0.8,
		"pdfPages": [{"pageNumber": 10, "bounds": "143.998,83.1995,1152.0033,1636.0026"}],
		"elements": [
			{"type": 100001, "inks": [{"x":1,"y":2,"pr":0.5},{"x":3,"y":4,"pr":0.5}], "width": 3},
			{"type": 400001, "text": "便签 $\\frac{a}{b}$", "color": "#FFFFE6A0"},
			{"type": 400002, "cells": [["工具","快捷键"],["笔","P"]]}
		]
	}`)
	add("Pages/page2.json", `{
		"elements": [{"type": 300001, "fileName": "abc.png"}]
	}`)
	add("Resources/Images/abc.png", "png-bytes")
	add("Resources/Document/textbook.pdf", "%PDF-1.4 fake")
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
}

func TestScanAndLoad(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "Maths"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeNote(t, filepath.Join(root, "Maths", "Al-jabr-1.note"))
	// a decoy that must be ignored
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	boards, err := Scan(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(boards) != 1 {
		t.Fatalf("want 1 board, got %d", len(boards))
	}
	b := boards[0]
	if b.Name != "Al-jabr-1" {
		t.Errorf("name = %q", b.Name)
	}
	if b.PageCount != 2 {
		t.Errorf("page count = %d, want 2", b.PageCount)
	}
	if b.Images != 1 {
		t.Errorf("images = %d, want 1", b.Images)
	}
	if !b.HasPDF || b.PDFName != "textbook.pdf" {
		t.Errorf("pdf = %v %q", b.HasPDF, b.PDFName)
	}
	if b.Size <= 0 {
		t.Errorf("size = %d", b.Size)
	}
	if b.Err != "" {
		t.Errorf("unexpected err %q", b.Err)
	}

	d, err := Load(b.Path, nil)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(d.Pages) != 2 {
		t.Fatalf("pages = %d, want 2", len(d.Pages))
	}
	p1 := d.Pages[0]
	if p1.Elements != 3 || p1.Ink != 2 || !p1.HasPDF || p1.Scale != 0.8 {
		t.Errorf("page1 = %+v", p1)
	}
	if p1.Types[TypeInk] != 1 || p1.Types[TypeSticky] != 1 || p1.Types[TypeTable] != 1 {
		t.Errorf("page1 types = %v", p1.Types)
	}
	if len(p1.Texts) != 5 { // sticky + 4 table cells
		t.Errorf("page1 texts = %v", p1.Texts)
	}
	p2 := d.Pages[1]
	if p2.Images != 1 || p2.Elements != 1 {
		t.Errorf("page2 = %+v", p2)
	}

	elements, ink, images, texts, withContent := d.Stats()
	if elements != 4 || ink != 2 || images != 1 || texts != 5 || withContent != 2 {
		t.Errorf("stats = %d %d %d %d %d", elements, ink, images, texts, withContent)
	}

	if !d.HasMath() {
		t.Error("HasMath should be true (sticky holds $\\frac{a}{b}$)")
	}
	hits := d.Search("快捷键")
	if len(hits) != 1 || hits[0].Number != 1 {
		t.Errorf("search hits = %v", hits)
	}
	if got := d.Search("不存在的词"); len(got) != 0 {
		t.Errorf("unexpected hits %v", got)
	}
}

func TestLoadRejectsNonZip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "broken.note")
	if err := os.WriteFile(path, []byte("definitely not a zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path, nil); err == nil {
		t.Fatal("want an error for a non-ZIP file")
	}
	boards, err := Scan(filepath.Dir(path))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(boards) != 1 || boards[0].Err == "" {
		t.Fatalf("scan should report the broken board, got %+v", boards)
	}
}

func TestTypeName(t *testing.T) {
	if TypeName(TypeSticky) != "便签" {
		t.Errorf("sticky label = %q", TypeName(TypeSticky))
	}
	if !strings.Contains(TypeName(999999), "999999") {
		t.Errorf("unknown type label = %q", TypeName(999999))
	}
}

func TestScanReportsProgress(t *testing.T) {
	root := t.TempDir()
	writeNote(t, filepath.Join(root, "board.note"))
	calls := 0
	var lastDone, lastTotal int
	if _, err := Load(filepath.Join(root, "board.note"), func(done, total int) {
		calls++
		lastDone, lastTotal = done, total
	}); err != nil {
		t.Fatalf("load: %v", err)
	}
	if calls == 0 || lastDone != 2 || lastTotal != 2 {
		t.Fatalf("progress calls=%d last=%d/%d", calls, lastDone, lastTotal)
	}
}
