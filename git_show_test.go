package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// showRepo builds a history covering every shape the commit view renders:
// a root commit, a modify/add/delete/rename/binary commit, and a merge.
// Returns the root and the hashes of the root, change, and merge commits.
func showRepo(t *testing.T) (root, first, change, merge string) {
	t.Helper()
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	root = t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	write := func(rel, body string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	head := func() string { return strings.TrimSpace(gitTestRun(t, root, "rev-parse", "HEAD")) }

	gitTestRun(t, root, "init", "-q", "-b", "main")
	gitTestRun(t, root, "config", "user.email", "t@example.com")
	gitTestRun(t, root, "config", "user.name", "T")
	gitTestRun(t, root, "config", "commit.gpgsign", "false")
	write("mod.go", "package main\n\nfunc a() {}\n")
	write("del.go", "gone\n")
	write("old.go", "package main\n\n// a file long enough that a rename is still detected as one\nfunc renamed() {}\n")
	gitTestRun(t, root, "add", "-A")
	gitTestRun(t, root, "commit", "-qm", "root commit")
	first = head()

	write("mod.go", "package main\n\nfunc a() {}\n\nfunc b() {}\n")
	write("new.go", "package main\n")
	os.Remove(filepath.Join(root, "del.go"))
	os.Rename(filepath.Join(root, "old.go"), filepath.Join(root, "moved.go"))
	write("img.bin", "\x00\x01\x02binary\x00")
	gitTestRun(t, root, "add", "-A")
	gitTestRun(t, root, "commit", "-qm", "change things", "-m", "Longer body.")
	change = head()

	gitTestRun(t, root, "checkout", "-qb", "side")
	write("side.go", "package main\n")
	gitTestRun(t, root, "add", "-A")
	gitTestRun(t, root, "commit", "-qm", "side work")
	gitTestRun(t, root, "checkout", "-q", "main")
	write("main2.go", "package main\n")
	gitTestRun(t, root, "add", "-A")
	gitTestRun(t, root, "commit", "-qm", "main work")
	gitTestRun(t, root, "merge", "-q", "--no-ff", "-m", "merge side", "side")
	merge = head()
	return
}

func filesByPath(files []CommitFile) map[string]CommitFile {
	m := map[string]CommitFile{}
	for _, f := range files {
		m[f.Path] = f
	}
	return m
}

func TestGitResolveCommitRejectsNonHex(t *testing.T) {
	root, first, _, _ := showRepo(t)
	for _, rev := range []string{"", "-x", "--output=/tmp/x", "HEAD", "HEAD~1", "main", "../a", "abc", first + "g", strings.Repeat("a", 65)} {
		if _, err := gitResolveCommit(root, rev); err != errBadRev {
			t.Errorf("gitResolveCommit(%q) = %v, want errBadRev", rev, err)
		}
	}
	if _, err := gitResolveCommit(root, "deadbeefdeadbeef"); err != errUnknownCommit {
		t.Errorf("unknown hex commit: got %v, want errUnknownCommit", err)
	}
	for _, rev := range []string{first, first[:7], strings.ToUpper(first[:10])} {
		got, err := gitResolveCommit(root, rev)
		if err != nil || got != first {
			t.Errorf("gitResolveCommit(%q) = %q, %v; want %q", rev, got, err, first)
		}
	}
}

func TestGitShowCommitFiles(t *testing.T) {
	root, first, change, _ := showRepo(t)
	c, err := gitShowCommit(root, change[:8])
	if err != nil {
		t.Fatal(err)
	}
	if c.Hash != change || c.Subject != "change things" || c.Body != "Longer body." || c.Author != "T" {
		t.Errorf("metadata = %+v", c)
	}
	if c.Merge || len(c.Parents) != 1 || c.Parents[0] != first {
		t.Errorf("parents = %v merge=%v, want [%s]", c.Parents, c.Merge, first)
	}
	files := filesByPath(c.Files)
	if len(files) != 5 {
		t.Fatalf("files = %+v, want 5", c.Files)
	}
	if f := files["mod.go"]; f.Status != "M" || f.Add != 2 || f.Del != 0 {
		t.Errorf("mod.go = %+v", f)
	}
	if f := files["new.go"]; f.Status != "A" || f.Add != 1 {
		t.Errorf("new.go = %+v", f)
	}
	if f := files["del.go"]; f.Status != "D" || f.Del != 1 {
		t.Errorf("del.go = %+v", f)
	}
	if f := files["moved.go"]; f.Status != "R" || f.OldPath != "old.go" {
		t.Errorf("moved.go = %+v", f)
	}
	if f := files["img.bin"]; !f.Binary {
		t.Errorf("img.bin = %+v, want binary", f)
	}
}

func TestGitShowRootCommit(t *testing.T) {
	root, first, _, _ := showRepo(t)
	c, err := gitShowCommit(root, first)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Parents) != 0 {
		t.Errorf("root commit parents = %v", c.Parents)
	}
	files := filesByPath(c.Files)
	if len(files) != 3 || files["mod.go"].Status != "A" || files["mod.go"].Add != 3 {
		t.Errorf("root commit files = %+v", c.Files)
	}
}

func TestGitShowMergeUsesFirstParent(t *testing.T) {
	root, _, _, merge := showRepo(t)
	c, err := gitShowCommit(root, merge)
	if err != nil {
		t.Fatal(err)
	}
	if !c.Merge || len(c.Parents) != 2 {
		t.Fatalf("merge = %v parents = %v", c.Merge, c.Parents)
	}
	files := filesByPath(c.Files)
	if len(files) != 1 || files["side.go"].Status != "A" {
		t.Errorf("merge files = %+v, want only side.go", c.Files)
	}
}

func TestParseCommitFilesCopyAndOddNames(t *testing.T) {
	ns := "M\x00a b.go\x00C75\x00src.go\x00dst.go\x00"
	num := "1\t2\ta b.go\x003\t0\t\x00src.go\x00dst.go\x00"
	got := parseCommitFiles(ns, num)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	if got[0] != (CommitFile{Path: "a b.go", Status: "M", Add: 1, Del: 2}) {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1] != (CommitFile{Path: "dst.go", OldPath: "src.go", Status: "C", Add: 3}) {
		t.Errorf("got[1] = %+v", got[1])
	}
	if len(parseCommitFiles("", "")) != 0 {
		t.Error("empty input should give no files")
	}
}

func showServer(t *testing.T, root string) *Server {
	t.Helper()
	ix := NewIndex(root)
	ix.Build()
	return NewServer(ix, nil)
}

func TestHandleGitShow(t *testing.T) {
	root, _, change, _ := showRepo(t)
	s := showServer(t, root)

	code, body := get(t, s, "/api/git/show?rev="+change[:7])
	if code != 200 || body["hash"] != change {
		t.Fatalf("show: %d %v", code, body)
	}
	if files, _ := body["files"].([]any); len(files) != 5 {
		t.Errorf("show files = %v", body["files"])
	}
	if code, _ := get(t, s, "/api/git/show?rev=-x"); code != 400 {
		t.Errorf("bad rev: %d, want 400", code)
	}
	if code, _ := get(t, s, "/api/git/show?rev=deadbeef"); code != 404 {
		t.Errorf("unknown rev: %d, want 404", code)
	}
}

func TestHandleGitShowDiff(t *testing.T) {
	root, _, change, _ := showRepo(t)
	s := showServer(t, root)
	diff := func(path string) (int, map[string]any) {
		return get(t, s, "/api/git/show/diff?rev="+change+"&path="+url.QueryEscape(path))
	}

	code, body := diff("mod.go")
	hunks, _ := body["hunks"].([]any)
	if code != 200 || len(hunks) != 1 || body["truncated"] != false {
		t.Fatalf("mod.go diff: %d %v", code, body)
	}
	adds := 0
	for _, r := range hunks[0].(map[string]any)["rows"].([]any) {
		if r.(map[string]any)["type"] == "add" {
			adds++
		}
	}
	if adds != 2 {
		t.Errorf("mod.go adds = %d, want 2", adds)
	}

	// A deleted file no longer exists on disk but is still reachable.
	if code, body := diff("del.go"); code != 200 || len(body["hunks"].([]any)) != 1 {
		t.Errorf("del.go diff: %d %v", code, body)
	}
	if code, body := diff("img.bin"); code != 200 || body["binary"] != true {
		t.Errorf("img.bin diff: %d %v", code, body)
	}
	// Anything the commit didn't touch is refused, including real files.
	for _, p := range []string{"main2.go", "../etc/passwd", ""} {
		if code, _ := diff(p); code != 400 {
			t.Errorf("path %q: %d, want 400", p, code)
		}
	}
}
