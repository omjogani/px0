package main

import (
	"bytes"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Read-only commit inspection behind the git panel's commit rows. Design and
// endpoints: docs/internals/git-integration.md §9.

var (
	errBadRev        = errors.New("invalid commit id")
	errUnknownCommit = errors.New("unknown commit")
)

// commitRevRe admits only a hex commit id, so refs, ranges and anything git
// could read as an option ("-...") never reach a git command.
var commitRevRe = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

// commitDiffMax caps one file's diff; past it the diff is cut and marked truncated.
const commitDiffMax = 2 << 20

// CommitFile is one path a commit changed, relative to its first parent.
type CommitFile struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"` // set for renames and copies
	Status  string `json:"status"`            // A, M, D, R, C, T
	Add     int    `json:"add"`
	Del     int    `json:"del"`
	Binary  bool   `json:"binary,omitempty"`
}

// CommitDetail is a commit's metadata and the files it changed. Immutable for
// a given hash, which is what makes commitCache safe.
type CommitDetail struct {
	Hash    string       `json:"hash"`
	Short   string       `json:"short"`
	Subject string       `json:"subject"`
	Body    string       `json:"body"`
	Author  string       `json:"author"`
	Date    string       `json:"date"` // committer date, strict ISO 8601
	Parents []string     `json:"parents"`
	Merge   bool         `json:"merge"`
	Files   []CommitFile `json:"files"`
	base    string       // first parent, or the empty tree for a root commit
}

// commitCache holds recent commits: each file opened from a commit re-reads it.
var commitCache = struct {
	sync.Mutex
	order []string
	m     map[string]*CommitDetail
}{m: map[string]*CommitDetail{}}

const commitCacheSize = 16

// gitResolveCommit validates rev and resolves it to the full hash of an
// existing commit.
func gitResolveCommit(root, rev string) (string, error) {
	if !commitRevRe.MatchString(rev) {
		return "", errBadRev
	}
	out, err := exec.Command("git", "-C", root, "rev-parse", "--verify", "--quiet", rev+"^{commit}").Output()
	if err != nil {
		return "", errUnknownCommit
	}
	return strings.TrimSpace(string(out)), nil
}

// gitEmptyTree returns the hash of the empty tree in root's object format, the
// base a root commit is diffed against.
func gitEmptyTree(root string) string {
	cmd := exec.Command("git", "-C", root, "hash-object", "-t", "tree", "--stdin")
	cmd.Stdin = strings.NewReader("")
	out, err := cmd.Output()
	if err != nil {
		return "4b825dc642cb6eb9a060e54bf8d69288fbee4904" // SHA-1 empty tree
	}
	return strings.TrimSpace(string(out))
}

// gitShowCommit returns rev's metadata and changed files. A merge commit is
// diffed against its first parent, the view of what the merge brought in.
func gitShowCommit(root, rev string) (*CommitDetail, error) {
	if !gitAvailable(root) {
		return nil, errUnknownCommit
	}
	hash, err := gitResolveCommit(root, rev)
	if err != nil {
		return nil, err
	}
	key := root + "\x00" + hash
	commitCache.Lock()
	if c, ok := commitCache.m[key]; ok {
		commitCache.Unlock()
		return c, nil
	}
	commitCache.Unlock()

	out, err := exec.Command("git", "-C", root, "show", "-s", "--no-color",
		"--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P%x1f%b", hash).Output()
	if err != nil {
		return nil, errUnknownCommit
	}
	parts := strings.SplitN(strings.TrimRight(string(out), "\n"), "\x1f", 7)
	for len(parts) < 7 {
		parts = append(parts, "")
	}
	c := &CommitDetail{
		Hash:    parts[0],
		Short:   parts[1],
		Subject: parts[2],
		Author:  parts[3],
		Date:    parts[4],
		Parents: strings.Fields(parts[5]),
		Body:    strings.TrimSpace(parts[6]),
	}
	c.Merge = len(c.Parents) > 1
	if len(c.Parents) > 0 {
		c.base = c.Parents[0]
	} else {
		c.base = gitEmptyTree(root)
	}

	nameStatus, err := exec.Command("git", "-C", root, "diff", "--no-color", "--no-ext-diff",
		"-M", "-z", "--name-status", c.base, c.Hash).Output()
	if err != nil {
		return nil, err
	}
	numstat, err := exec.Command("git", "-C", root, "diff", "--no-color", "--no-ext-diff",
		"-M", "-z", "--numstat", c.base, c.Hash).Output()
	if err != nil {
		return nil, err
	}
	c.Files = parseCommitFiles(string(nameStatus), string(numstat))

	commitCache.Lock()
	if _, ok := commitCache.m[key]; !ok {
		commitCache.m[key] = c
		commitCache.order = append(commitCache.order, key)
		if len(commitCache.order) > commitCacheSize {
			delete(commitCache.m, commitCache.order[0])
			commitCache.order = commitCache.order[1:]
		}
	}
	commitCache.Unlock()
	return c, nil
}

// parseCommitFiles joins `git diff -z --name-status` (status and paths) with
// `git diff -z --numstat` (line counts) by new path. In -z form a rename or
// copy is "R100\0old\0new\0" in name-status and "add\tdel\t\0old\0new\0" in
// numstat; a binary file has "-" for both counts.
func parseCommitFiles(nameStatus, numstat string) []CommitFile {
	type stat struct {
		add, del int
		binary   bool
	}
	stats := map[string]stat{}
	toks := strings.Split(numstat, "\x00")
	for i := 0; i < len(toks); {
		t := toks[i]
		i++
		f := strings.SplitN(t, "\t", 3)
		if len(f) < 3 {
			continue
		}
		path := f[2]
		if path == "" { // rename/copy: old and new follow as their own tokens
			if i+1 >= len(toks) {
				break
			}
			path = toks[i+1]
			i += 2
		}
		st := stat{binary: f[0] == "-" && f[1] == "-"}
		st.add, _ = strconv.Atoi(f[0])
		st.del, _ = strconv.Atoi(f[1])
		stats[path] = st
	}

	files := []CommitFile{}
	toks = strings.Split(nameStatus, "\x00")
	for i := 0; i < len(toks); {
		st := toks[i]
		i++
		if st == "" {
			continue
		}
		f := CommitFile{Status: st[:1]}
		if f.Status == "R" || f.Status == "C" {
			if i+1 >= len(toks) {
				break
			}
			f.OldPath, f.Path = toks[i], toks[i+1]
			i += 2
		} else {
			if i >= len(toks) {
				break
			}
			f.Path = toks[i]
			i++
		}
		if s, ok := stats[f.Path]; ok {
			f.Add, f.Del, f.Binary = s.add, s.del, s.binary
		}
		files = append(files, f)
	}
	return files
}

// gitCommitFileDiff returns f's unified diff within c, cut at commitDiffMax.
// Both paths of a rename are passed so -M pairs them into one entry.
func gitCommitFileDiff(root string, c *CommitDetail, f CommitFile) (diff string, truncated bool, err error) {
	args := []string{"-C", root, "diff", "--no-color", "--no-ext-diff", "-M", c.base, c.Hash, "--", f.Path}
	if f.OldPath != "" {
		args = append(args, f.OldPath)
	}
	cmd := exec.Command("git", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", false, err
	}
	if err := cmd.Start(); err != nil {
		return "", false, err
	}
	buf, readErr := io.ReadAll(io.LimitReader(stdout, commitDiffMax+1))
	if len(buf) > commitDiffMax {
		truncated = true
		buf = buf[:commitDiffMax]
		if nl := bytes.LastIndexByte(buf, '\n'); nl >= 0 {
			buf = buf[:nl+1]
		}
		cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if readErr != nil {
		return "", false, readErr
	}
	if waitErr != nil && !truncated {
		return "", false, waitErr
	}
	return string(buf), truncated, nil
}
