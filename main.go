// random-img 轻量后端：静态资源 + 收藏持久化 + 收藏页账号验证。
//
// 默认监听 127.0.0.1:8765（仅本机）。
// 环境变量:
//   ADDR=127.0.0.1:8765
//   DATA_DIR=./data
//   AUTH_DB_PATH=<path to private accounts.sqlite>
package main

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	passwordIterations = 600_000
	passwordSaltSize   = 16
	passwordHashSize   = 32
	sessionCookieName  = "random_img_session"
	sessionDuration    = 7 * 24 * time.Hour
)

type FavoriteItem map[string]any

type favoritesStore struct {
	Items []FavoriteItem `json:"items"`
}

type server struct {
	mu         sync.Mutex
	path       string
	store      favoritesStore
	authDB     *sql.DB
	sessionsMu sync.Mutex
	sessions   map[string]time.Time
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func main() {
	addr := envOr("ADDR", "127.0.0.1:8765")
	dataDir := envOr("DATA_DIR", "./data")
	configDir, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	authDBPath := envOr("AUTH_DB_PATH", filepath.Join(configDir, "random-img", "accounts.sqlite"))

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	authDB, err := openAuthDB(authDBPath)
	if err != nil {
		log.Fatal(err)
	}

	storePath := filepath.Join(dataDir, "favorites.json")
	s := &server{path: storePath, authDB: authDB, sessions: make(map[string]time.Time)}
	if err := s.load(); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/status", s.handleAuthStatus)
	mux.HandleFunc("/api/auth/setup", s.handleAuthSetup)
	mux.HandleFunc("/api/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/api/auth/logout", s.handleAuthLogout)
	mux.HandleFunc("/api/favorites", s.handleFavorites)
	mux.HandleFunc("/api/favorites/", s.handleFavoriteByKey)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    true,
			"time":  time.Now().UTC().Format(time.RFC3339),
			"count": len(s.snapshot()),
		})
	})

	log.Printf("random-img listening on http://%s  (favorites=%s, auth=%s)", addr, storePath, authDBPath)
	log.Fatal(http.ListenAndServe(addr, withCORS(mux)))
}

func openAuthDB(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS account (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		username TEXT NOT NULL UNIQUE,
		salt BLOB NOT NULL,
		password_hash BLOB NOT NULL,
		created_at TEXT NOT NULL
	)`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func (s *server) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.store = favoritesStore{Items: []FavoriteItem{}}
			return s.saveLocked()
		}
		return err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		s.store = favoritesStore{Items: []FavoriteItem{}}
		return nil
	}
	var store favoritesStore
	if err := json.Unmarshal(data, &store); err != nil {
		var arr []FavoriteItem
		if err2 := json.Unmarshal(data, &arr); err2 != nil {
			return err
		}
		store.Items = arr
	}
	if store.Items == nil {
		store.Items = []FavoriteItem{}
	}
	s.store = store
	return nil
}

func (s *server) saveLocked() error {
	tmp := s.path + ".tmp"
	raw, err := json.MarshalIndent(s.store, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *server) snapshot() []FavoriteItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]FavoriteItem, len(s.store.Items))
	copy(out, s.store.Items)
	return out
}

func (s *server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	configured, err := s.accountExists()
	if err != nil {
		http.Error(w, "auth storage unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"setupRequired": !configured,
		"authenticated": s.hasSession(r),
	})
}

func (s *server) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireSameOrigin(w, r) {
		return
	}
	var input credentials
	if err := decodeCredentials(r, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	input.Username = strings.TrimSpace(input.Username)
	if len(input.Username) < 1 || len(input.Username) > 64 || len(input.Password) < 10 || len(input.Password) > 128 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "账号不能为空，密码长度需为 10 到 128 个字符"})
		return
	}
	configured, err := s.accountExists()
	if err != nil {
		http.Error(w, "auth storage unavailable", http.StatusInternalServerError)
		return
	}
	if configured {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "账号已设置，请登录"})
		return
	}

	salt := make([]byte, passwordSaltSize)
	if _, err := rand.Read(salt); err != nil {
		http.Error(w, "could not create account", http.StatusInternalServerError)
		return
	}
	hash, err := pbkdf2.Key(sha256.New, input.Password, salt, passwordIterations, passwordHashSize)
	if err != nil {
		http.Error(w, "could not create account", http.StatusInternalServerError)
		return
	}
	_, err = s.authDB.Exec(`INSERT INTO account (id, username, salt, password_hash, created_at) VALUES (1, ?, ?, ?, ?)`,
		input.Username, salt, hash, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "账号已设置，请登录"})
		return
	}
	if !s.issueSession(w, r) {
		http.Error(w, "could not create session", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireSameOrigin(w, r) {
		return
	}
	var input credentials
	if err := decodeCredentials(r, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	var salt, storedHash []byte
	err := s.authDB.QueryRow(`SELECT salt, password_hash FROM account WHERE id = 1 AND username = ?`, strings.TrimSpace(input.Username)).Scan(&salt, &storedHash)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "账号或密码错误"})
		return
	}
	actualHash, err := pbkdf2.Key(sha256.New, input.Password, salt, passwordIterations, passwordHashSize)
	if err != nil || !hmac.Equal(actualHash, storedHash) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "账号或密码错误"})
		return
	}
	if !s.issueSession(w, r) {
		http.Error(w, "could not create session", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireSameOrigin(w, r) {
		return
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		s.sessionsMu.Lock()
		delete(s.sessions, cookie.Value)
		s.sessionsMu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: "", Path: "/api", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: requestIsSecure(r),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func decodeCredentials(r *http.Request, input *credentials) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(input)
}

func (s *server) accountExists() (bool, error) {
	var count int
	err := s.authDB.QueryRow(`SELECT COUNT(*) FROM account`).Scan(&count)
	return count > 0, err
}

func (s *server) issueSession(w http.ResponseWriter, r *http.Request) bool {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return false
	}
	token := base64.RawURLEncoding.EncodeToString(bytes)
	expires := time.Now().Add(sessionDuration)
	s.sessionsMu.Lock()
	s.sessions[token] = expires
	s.sessionsMu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: token, Path: "/api", Expires: expires,
		MaxAge: int(sessionDuration.Seconds()), HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: requestIsSecure(r),
	})
	return true
}

func (s *server) hasSession(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return false
	}
	now := time.Now()
	s.sessionsMu.Lock()
	defer s.sessionsMu.Unlock()
	expires, ok := s.sessions[cookie.Value]
	if !ok || !now.Before(expires) {
		delete(s.sessions, cookie.Value)
		return false
	}
	return true
}

func (s *server) requireSession(w http.ResponseWriter, r *http.Request) bool {
	if s.hasSession(r) {
		return true
	}
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
	return false
}

func (s *server) requireSameOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	expectedScheme := "http"
	if requestIsSecure(r) {
		expectedScheme = "https"
	}
	if err != nil || origin.Host == "" || !strings.EqualFold(origin.Host, r.Host) || !strings.EqualFold(origin.Scheme, expectedScheme) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "same-origin request required"})
		return false
	}
	return true
}

func requestIsSecure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (s *server) handleFavorites(w http.ResponseWriter, r *http.Request) {
	if !s.requireSession(w, r) {
		return
	}
	if (r.Method == http.MethodPost || r.Method == http.MethodPut) && !s.requireSameOrigin(w, r) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		items := s.snapshot()
		writeJSON(w, http.StatusOK, map[string]any{"count": len(items), "items": items})
	case http.MethodPost:
		s.addFavorite(w, r)
	case http.MethodPut:
		s.replaceAll(w, r)
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) handleFavoriteByKey(w http.ResponseWriter, r *http.Request) {
	if !s.requireSession(w, r) {
		return
	}
	if r.Method == http.MethodDelete && !s.requireSameOrigin(w, r) {
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/favorites/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		http.Error(w, "expected /api/favorites/{source}/{id}", http.StatusBadRequest)
		return
	}
	source, id := parts[0], parts[1]
	switch r.Method {
	case http.MethodDelete:
		s.deleteFavorite(w, source, id)
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) addFavorite(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read body failed", http.StatusBadRequest)
		return
	}
	var item FavoriteItem
	if err := json.Unmarshal(body, &item); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	source, id, err := extractKey(item)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	item["source"] = source
	item["id"] = id

	s.mu.Lock()
	defer s.mu.Unlock()
	found := -1
	for i, it := range s.store.Items {
		if keyOf(it) == source+"_"+id {
			found = i
			break
		}
	}
	if found >= 0 {
		s.store.Items[found] = item
	} else {
		s.store.Items = append([]FavoriteItem{item}, s.store.Items...)
	}
	if err := s.saveLocked(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "source": source, "id": id})
}

func (s *server) deleteFavorite(w http.ResponseWriter, source, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := source + "_" + id
	next := make([]FavoriteItem, 0, len(s.store.Items))
	deleted := 0
	for _, it := range s.store.Items {
		if keyOf(it) == key {
			deleted++
			continue
		}
		next = append(next, it)
	}
	s.store.Items = next
	if err := s.saveLocked(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

func (s *server) replaceAll(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		http.Error(w, "read body failed", http.StatusBadRequest)
		return
	}
	var payload struct {
		Items []FavoriteItem `json:"items"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		var arr []FavoriteItem
		if err2 := json.Unmarshal(body, &arr); err2 != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		payload.Items = arr
	}

	cleaned := make([]FavoriteItem, 0, len(payload.Items))
	seen := map[string]struct{}{}
	for _, item := range payload.Items {
		source, id, err := extractKey(item)
		if err != nil {
			continue
		}
		key := source + "_" + id
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		item["source"] = source
		item["id"] = id
		cleaned = append(cleaned, item)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.store.Items = cleaned
	if err := s.saveLocked(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(cleaned)})
}

func keyOf(item FavoriteItem) string {
	source, _ := item["source"].(string)
	return strings.TrimSpace(source) + "_" + stringifyID(item["id"])
}

func extractKey(item FavoriteItem) (source, id string, err error) {
	source, _ = item["source"].(string)
	source = strings.TrimSpace(source)
	id = stringifyID(item["id"])
	if source == "" || id == "" {
		return "", "", errors.New("item.source and item.id are required")
	}
	return source, id, nil
}

func stringifyID(v any) string {
	switch value := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(value)
	case float64:
		if value == float64(int64(value)) {
			return strconv.FormatInt(int64(value), 10)
		}
		return strconv.FormatFloat(value, 'f', -1, 64)
	case json.Number:
		return value.String()
	default:
		b, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		return strings.Trim(string(b), "\"")
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}