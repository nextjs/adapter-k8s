// The middle cache stores build-file bytes only. Every request first visits the pool's
// routing/middleware boundary, including cache hits and conditional requests.
package main

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const assetHeader = "X-Adapter-Asset"
const requestHeader = "X-Adapter-Middle-Cache"
const maxCacheBytes = 64 << 20
const maxFileBytes = 1 << 20
const maxEntries = 4096

type asset struct {
	FilePath  string `json:"filePath"`
	Prerender bool   `json:"prerender"`
	Status    int    `json:"status"`
}

type cachedFile struct {
	id   string
	data []byte
	etag string
}

type fileCache struct {
	root    *os.Root
	assets  map[string]string
	mu      sync.Mutex
	entries map[string]*list.Element
	lru     *list.List
	size    int
	// Bound cold-read buffers and hashing work. Saturation falls back to streaming disk.
	reads  chan struct{}
	serves chan struct{}
}

func newFileCache(root *os.Root, manifest []asset) (*fileCache, error) {
	c := &fileCache{root: root, assets: map[string]string{}, entries: map[string]*list.Element{}, lru: list.New(), reads: make(chan struct{}, 4), serves: make(chan struct{}, 64)}
	for _, a := range manifest {
		if a.Prerender || (a.Status != 0 && a.Status != 200) {
			continue
		}
		// OpenRoot enforces containment, including symlinks. Validate the inventory at boot
		// so readiness cannot promote an image whose asset corpus is missing.
		f, err := root.Open(a.FilePath)
		if err != nil {
			return nil, fmt.Errorf("asset inventory: %w", err)
		}
		info, err := f.Stat()
		f.Close()
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, errors.New("asset is not a regular file")
		}
		h := sha256.Sum256([]byte(a.FilePath))
		c.assets[hex.EncodeToString(h[:])] = a.FilePath
	}
	return c, nil
}

func (c *fileCache) get(id string) *cachedFile {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e := c.entries[id]; e != nil {
		c.lru.MoveToFront(e)
		return e.Value.(*cachedFile)
	}
	return nil
}

func (c *fileCache) put(f *cachedFile) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries[f.id] != nil {
		return
	}
	for c.size+len(f.data) > maxCacheBytes || c.lru.Len() >= maxEntries {
		e := c.lru.Back()
		delete(c.entries, e.Value.(*cachedFile).id)
		c.size -= len(e.Value.(*cachedFile).data)
		c.lru.Remove(e)
	}
	c.entries[f.id] = c.lru.PushFront(f)
	c.size += len(f.data)
}

func (c *fileCache) serve(w http.ResponseWriter, r *http.Request, id string) {
	// Slow clients can retain evicted byte slices. Bound those references and open files
	// as well as the LRU itself; otherwise cache eviction does not bound resident memory.
	select {
	case c.serves <- struct{}{}:
		defer func() { <-c.serves }()
	default:
		w.Header().Del("Content-Length")
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "Asset capacity exhausted", http.StatusServiceUnavailable)
		return
	}
	name, ok := c.assets[id]
	if !ok {
		assetError(w)
		return
	}
	if hit := c.get(id); hit != nil {
		serveContent(w, r, bytes.NewReader(hit.data), hit.etag)
		return
	}
	f, err := c.root.Open(name)
	if err != nil {
		assetError(w)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		assetError(w)
		return
	}
	select {
	case c.reads <- struct{}{}:
		// Release admission before serving a slow client, so disk work has a bounded
		// concurrency independent of download duration.
		h := sha1.New()
		var data []byte
		if info.Size() <= maxFileBytes {
			data, err = io.ReadAll(io.LimitReader(f, maxFileBytes+1))
			if err == nil && len(data) <= maxFileBytes {
				_, err = h.Write(data)
			} else if err == nil {
				err = errors.New("asset changed size")
			}
		} else {
			_, err = io.Copy(h, f)
		}
		<-c.reads
		if err == nil {
			etag := `"` + base64.RawURLEncoding.EncodeToString(h.Sum(nil)) + `"`
			if data != nil {
				c.put(&cachedFile{id: id, data: data, etag: etag})
				serveContent(w, r, bytes.NewReader(data), etag)
				return
			}
			if _, err = f.Seek(0, io.SeekStart); err == nil {
				serveContent(w, r, f, etag)
				return
			}
		}
		// A failed cache fill is a disk miss, never a skipped authorization decision.
		if _, err = f.Seek(0, io.SeekStart); err != nil {
			assetError(w)
			return
		}
	default:
	}
	serveContent(w, r, f, "")
}

func serveContent(w http.ResponseWriter, r *http.Request, content io.ReadSeeker, etag string) {
	w.Header().Del("Content-Length")
	if w.Header().Get("ETag") == "" && etag != "" {
		w.Header().Set("ETag", etag)
	}
	// A zero modtime avoids inventing a Last-Modified validator from OCI layer timestamps.
	// ServeContent implements HEAD, Range and HTTP preconditions after middleware ran.
	http.ServeContent(w, r, "", time.Time{}, content)
}

func assetError(w http.ResponseWriter) {
	w.Header().Del("Content-Length")
	w.Header().Del("ETag")
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "Asset unavailable", http.StatusBadGateway)
}

// Intercept only an empty, pool-authorized response. All other responses retain Go's
// ReverseProxy streaming and WebSocket support, including cancellation on disconnect.
type assetWriter struct {
	http.ResponseWriter
	request *http.Request
	cache   *fileCache
	handled bool
}

func (w *assetWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *assetWriter) WriteHeader(status int) {
	id := w.Header().Get(assetHeader)
	w.Header().Del(assetHeader)
	w.Header().Del(requestHeader)
	if id != "" {
		w.handled = true
		if status != 200 || (w.request.Method != "GET" && w.request.Method != "HEAD") {
			assetError(w.ResponseWriter)
			return
		}
		w.cache.serve(w.ResponseWriter, w.request, id)
		return
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *assetWriter) Write(b []byte) (int, error) {
	if w.handled {
		return len(b), nil
	}
	return w.ResponseWriter.Write(b)
}

func proxyHandler(cache *fileCache, target *url.URL) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL.Scheme = target.Scheme
			p.Out.URL.Host = target.Host
			p.Out.URL.RawQuery = p.In.URL.RawQuery
			// Preserve the exact target, Host and forwarding witnesses authenticated by
			// ext_proc. ReverseProxy normally drops Forwarded/X-Forwarded-* in Rewrite.
			for _, h := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
				if values, ok := p.In.Header[h]; ok {
					p.Out.Header[h] = append([]string(nil), values...)
				}
			}
			p.Out.Header.Del(assetHeader)
			p.Out.Header.Set(requestHeader, "1")
		},
		Transport:     &http.Transport{Proxy: nil, DisableCompression: true, MaxIdleConnsPerHost: 64, IdleConnTimeout: 90 * time.Second},
		FlushInterval: -1,
		ErrorHandler:  func(w http.ResponseWriter, _ *http.Request, _ error) { assetError(w) },
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(&assetWriter{ResponseWriter: w, request: r, cache: cache}, r)
	})
}

// Shutdown must outlive Listen's return. It also must wait for upgraded connections:
// http.Server.Shutdown deliberately does not wait for hijacked WebSockets.
func serveUntilStopped(ctx context.Context, server *http.Server, listener net.Listener) error {
	var active sync.WaitGroup
	handler := server.Handler
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		active.Add(1)
		defer active.Done()
		handler.ServeHTTP(w, r)
	})
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-ctx.Done()
		drain, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := server.Shutdown(drain); err != nil {
			server.Close()
		}
		finished := make(chan struct{})
		go func() { active.Wait(); close(finished) }()
		select {
		case <-finished:
		case <-drain.Done():
		}
	}()
	err := server.Serve(listener)
	if err != http.ErrServerClosed {
		return err
	}
	<-drained
	return nil
}

func main() {
	root, err := os.OpenRoot("/app")
	if err != nil {
		log.Fatal(err)
	}
	defer root.Close()
	data, err := root.ReadFile("config/static-assets.json")
	if err != nil {
		log.Fatal(err)
	}
	var manifest []asset
	if err = json.Unmarshal(data, &manifest); err != nil {
		log.Fatal(err)
	}
	cache, err := newFileCache(root, manifest)
	if err != nil {
		log.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:3001")
	listenAddress := os.Getenv("MIDDLE_CACHE_LISTEN_ADDRESS")
	if listenAddress == "" {
		listenAddress = ":3000"
	}
	server := &http.Server{Addr: listenAddress, Handler: proxyHandler(cache, target), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("middle cache listening on %s", listenAddress)
	if err := serveUntilStopped(ctx, server, listener); err != nil {
		log.Fatal(err)
	}
}
