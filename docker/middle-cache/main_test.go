package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fixture(t *testing.T) (*fileCache, string, string) {
	t.Helper()
	dir := t.TempDir()
	name := "asset % é.txt"
	if err := os.WriteFile(filepath.Join(dir, name), []byte("asset bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	c, err := newFileCache(root, []asset{{FilePath: name}})
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte(name))
	return c, hex.EncodeToString(h[:]), filepath.Join(dir, name)
}

func TestAuthorizationAndHeadersOnEveryHit(t *testing.T) {
	c, id, file := fixture(t)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if r.Header.Get(requestHeader) != "1" || r.Header.Get(assetHeader) != "" {
			t.Error("untrusted handoff headers")
		}
		if r.RequestURI != "/rewrite%20me?x=1&x=2" || r.Host != "app.example" || r.Header.Get("X-Forwarded-Proto") != "https" {
			t.Error("routing proof inputs changed")
		}
		w.Header().Add("Set-Cookie", fmt.Sprintf("visit=%d", n))
		w.Header().Add("Set-Cookie", "other=1")
		w.Header().Set("X-Middleware-User", r.Header.Get("Authorization"))
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Vary", "Cookie")
		if r.Header.Get("Authorization") == "denied" {
			http.Error(w, "denied", 403)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set(assetHeader, id)
		w.Header().Set("Content-Length", "0")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	proxy := httptest.NewServer(proxyHandler(c, target))
	defer proxy.Close()
	var etag string
	for i, user := range []string{"alice", "bob", "denied", "carol"} {
		r, _ := http.NewRequest("GET", proxy.URL+"/rewrite%20me?x=1&x=2", nil)
		r.Host = "app.example"
		r.Header.Set("Authorization", user)
		r.Header.Set("X-Forwarded-Proto", "https")
		r.Header.Set(assetHeader, "forged")
		r.Header.Set(requestHeader, "forged")
		if i >= 2 {
			r.Header.Set("If-None-Match", etag)
		}
		res, err := proxy.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if res.Header.Get(assetHeader) != "" || res.Header.Get(requestHeader) != "" {
			t.Fatal("private headers leaked")
		}
		if res.Header.Get("X-Middleware-User") != user || len(res.Header.Values("Set-Cookie")) != 2 || res.Header.Values("Set-Cookie")[0] != fmt.Sprintf("visit=%d", i+1) {
			t.Fatal("middleware headers were lost or cached")
		}
		if res.Header.Get("Cache-Control") != "no-cache" || res.Header.Get("Vary") != "Cookie" {
			t.Fatal("cache policy changed")
		}
		switch i {
		case 0, 1:
			if res.StatusCode != 200 || string(b) != "asset bytes" {
				t.Fatalf("asset: %d %q", res.StatusCode, b)
			}
			etag = res.Header.Get("ETag")
			if etag == "" {
				t.Fatal("missing etag")
			}
		case 2:
			if res.StatusCode != 403 {
				t.Fatal("warm cache bypassed authorization")
			}
		case 3:
			if res.StatusCode != 304 || len(b) != 0 {
				t.Fatal("conditional request did not reauthorize")
			}
		}
		// Proves subsequent responses use cached bytes rather than rereading the file.
		if i == 0 {
			if err := os.Remove(file); err != nil {
				t.Fatal(err)
			}
		}
	}
	if calls.Load() != 4 {
		t.Fatal("middleware skipped")
	}
}

func TestFileSemantics(t *testing.T) {
	c, id, _ := fixture(t)
	for _, tc := range []struct {
		method, header, value string
		status                int
		body                  string
	}{
		{"GET", "", "", 200, "asset bytes"},
		{"HEAD", "", "", 200, ""},
		{"GET", "Range", "bytes=1-3", 206, "sse"},
		{"GET", "If-None-Match", `W/"custom"`, 304, ""},
		{"GET", "If-Match", `"wrong"`, 412, ""},
	} {
		r := httptest.NewRequest(tc.method, "/asset", nil)
		if tc.header != "" {
			r.Header.Set(tc.header, tc.value)
		}
		w := httptest.NewRecorder()
		w.Header().Set("ETag", `"custom"`)
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Cache-Control", "no-cache")
		c.serve(w, r, id)
		if w.Code != tc.status || w.Body.String() != tc.body {
			t.Fatalf("%s %s: %d %q", tc.method, tc.header, w.Code, w.Body.String())
		}
		if tc.method == "HEAD" && w.Header().Get("Content-Length") != "11" {
			t.Fatal("HEAD size lost")
		}
	}
}

func TestInventoryAndBuildIsolation(t *testing.T) {
	c, id, file := fixture(t)
	other, _, _ := fixture(t)
	w := httptest.NewRecorder()
	c.serve(w, httptest.NewRequest("GET", "/", nil), id)
	if err := os.WriteFile(file, []byte("changed build"), 0600); err != nil {
		t.Fatal(err)
	}
	if other.get(id) != nil {
		t.Fatal("cache shared between builds")
	}
	for _, name := range []string{"../escape", "/etc/passwd"} {
		if _, err := newFileCache(c.root, []asset{{FilePath: name}}); err == nil {
			t.Fatal("escaping inventory admitted")
		}
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(filepath.Dir(file), "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := newFileCache(c.root, []asset{{FilePath: "escape"}}); err == nil {
		t.Fatal("symlink escape admitted")
	}
	prerenders, err := newFileCache(c.root, []asset{{FilePath: "missing.html", Prerender: true}})
	if err != nil || len(prerenders.assets) != 0 {
		t.Fatal("prerender entered inventory")
	}
	w = httptest.NewRecorder()
	c.serve(w, httptest.NewRequest("GET", "/", nil), "forged")
	if w.Code != 502 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unknown asset did not fail closed")
	}
}

func TestBoundedCacheAndConcurrentReads(t *testing.T) {
	c, id, _ := fixture(t)
	var wg sync.WaitGroup
	for range 32 {
		wg.Go(func() {
			w := httptest.NewRecorder()
			c.serve(w, httptest.NewRequest("GET", "/", nil), id)
			if w.Code != 200 || w.Body.String() != "asset bytes" {
				t.Error("concurrent read failed")
			}
		})
	}
	wg.Wait()
	for i := 0; i < maxEntries+10; i++ {
		c.put(&cachedFile{id: fmt.Sprint(i), data: []byte("x")})
	}
	if c.lru.Len() != maxEntries || c.get(id) != nil {
		t.Fatal("entry eviction failed")
	}
	for i := 0; i < 70; i++ {
		c.put(&cachedFile{id: fmt.Sprintf("large-%d", i), data: make([]byte, maxFileBytes)})
	}
	if c.size > maxCacheBytes {
		t.Fatal("byte budget exceeded")
	}
	for range cap(c.reads) {
		c.reads <- struct{}{}
	}
	w := httptest.NewRecorder()
	c.serve(w, httptest.NewRequest("GET", "/", nil), id)
	if w.Body.String() != "asset bytes" {
		t.Fatal("admission saturation did not stream disk")
	}
}

func TestDynamicStreamingAndWebSocket(t *testing.T) {
	c, _, _ := fixture(t)
	finish := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/socket" {
			conn, rw, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			fmt.Fprint(rw, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
			rw.Flush()
			b := make([]byte, 4)
			if _, err := io.ReadFull(rw, b); err == nil {
				conn.Write(b)
			}
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-finish
		fmt.Fprint(w, "data: last\n\n")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	proxy := httptest.NewServer(proxyHandler(c, target))
	defer proxy.Close()
	client := proxy.Client()
	client.Timeout = 3 * time.Second
	res, err := client.Get(proxy.URL + "/stream")
	close(finish)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || !strings.Contains(string(b), "data: last") {
		t.Fatal("stream lost")
	}
	addr := strings.TrimPrefix(proxy.URL, "http://")
	conn, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(conn, "GET /socket HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", addr)
	rw := bufio.NewReader(conn)
	upgrade, err := http.ReadResponse(rw, &http.Request{Method: "GET"})
	if err != nil || upgrade.StatusCode != 101 {
		t.Fatalf("upgrade failed: %v", err)
	}
	conn.Write([]byte("ping"))
	pong := make([]byte, 4)
	if _, err = io.ReadFull(rw, pong); err != nil || string(pong) != "ping" {
		t.Fatal("upgrade tunnel failed", err)
	}
}

func TestShutdownDrainsInFlightResponse(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	finish := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-finish
		fmt.Fprint(w, "complete")
	})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveUntilStopped(ctx, server, listener) }()
	result := make(chan string, 1)
	go func() {
		client := &http.Client{Timeout: 3 * time.Second}
		res, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			result <- err.Error()
			return
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		result <- string(body)
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		t.Fatalf("returned before draining: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	close(finish)
	if body := <-result; body != "complete" {
		t.Fatal("dropped response", body)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
