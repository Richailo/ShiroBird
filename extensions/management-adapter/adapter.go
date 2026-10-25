// SPDX-License-Identifier: AGPL-3.0-only
// Package shirobirdflow adds opt-in telemetry to existing NetBird control messages.
package shirobirdflow

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	pb "github.com/netbirdio/netbird/shared/management/proto"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"
)

const configEnv = "SHIROBIRD_FLOW_CONFIG_FILE"
const tokenLifetime = 24 * time.Hour
const maxRelayTTL = 16 * time.Hour

var identifier = regexp.MustCompile("^[A-Za-z0-9_-]{1,80}$")

type settings struct {
	Enabled         bool     `json:"enabled"`
	ReceiverURL     string   `json:"receiver_url"`
	SecretFile      string   `json:"secret_file"`
	PeerIDs         []string `json:"peer_ids"`
	GroupIDs        []string `json:"group_ids"`
	IntervalSeconds int      `json:"interval_seconds"`
	Counters        bool     `json:"counters"`
}

func boundedRead(path string, maximum int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(data)) > maximum {
		return nil, errors.New("invalid input size")
	}
	return data, nil
}

func readSettings() (*settings, []byte, error) {
	path := os.Getenv(configEnv)
	if path == "" {
		return nil, nil, nil
	}
	data, err := boundedRead(path, 65536)
	if err != nil {
		return nil, nil, errors.New("read ShiroBird flow configuration")
	}
	var cfg settings
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return nil, nil, errors.New("invalid ShiroBird flow configuration")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, nil, errors.New("trailing ShiroBird configuration")
	}
	if !cfg.Enabled {
		return &cfg, nil, nil
	}
	endpoint, err := url.Parse(cfg.ReceiverURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		(endpoint.Path != "" && endpoint.Path != "/") {
		return nil, nil, errors.New("ShiroBird receiver must be an HTTPS origin")
	}
	if cfg.IntervalSeconds < 10 || cfg.IntervalSeconds > 600 {
		return nil, nil, errors.New("ShiroBird reporting interval must be 10..600 seconds")
	}
	if len(cfg.PeerIDs)+len(cfg.GroupIDs) == 0 {
		return nil, nil, errors.New("ShiroBird requires explicit peer or group selection")
	}
	for _, ids := range [][]string{cfg.PeerIDs, cfg.GroupIDs} {
		for _, id := range ids {
			if !identifier.MatchString(id) {
				return nil, nil, errors.New("invalid ShiroBird selection")
			}
		}
	}
	secret, err := boundedRead(cfg.SecretFile, 4096)
	if err != nil {
		return nil, nil, errors.New("read ShiroBird signing secret")
	}
	secret = []byte(strings.TrimSpace(string(secret)))
	if len(secret) < 32 {
		return nil, nil, errors.New("ShiroBird signing secret too short")
	}
	return &cfg, secret, nil
}

// ValidateRefresh rejects activation when native refresh cannot renew flow credentials.
func ValidateRefresh(hasRelay bool, relayTTL time.Duration) error {
	if os.Getenv(configEnv) == "" {
		return nil
	}
	if _, _, err := readSettings(); err != nil {
		return err
	}
	// Required while disabled too: the operator can later enable the file.
	if !hasRelay || relayTTL <= 0 || relayTTL > maxRelayTTL {
		return errors.New("ShiroBird requires a relay credential TTL greater than zero and at most 16h")
	}
	return nil
}

func selected(cfg *settings, peerID string, groups []string) bool {
	for _, id := range cfg.PeerIDs {
		if peerID == id {
			return true
		}
	}
	for _, wanted := range cfg.GroupIDs {
		for _, group := range groups {
			if wanted == group {
				return true
			}
		}
	}
	return false
}

func credentials(secret []byte, peerID string, now time.Time) (string, string) {
	// Stable windows avoid restarting the sender on every routine map update.
	expiry := now.Truncate(5 * time.Minute).Add(tokenLifetime).Unix()
	body, _ := json.Marshal(struct {
		Version  int    `json:"v"`
		Audience string `json:"aud"`
		PeerID   string `json:"peer_id"`
		Expiry   int64  `json:"exp"`
	}{1, "shirobird-native-flow", peerID, expiry})
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(payload))
	return payload, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// Extend preserves existing fields and adds telemetry for explicitly selected peers.
func Extend(peerID string, groups []string, config *pb.NetbirdConfig) *pb.NetbirdConfig {
	return extendAt(peerID, groups, config, time.Now())
}

func extendAt(peerID string, groups []string, config *pb.NetbirdConfig, now time.Time) *pb.NetbirdConfig {
	// A nil map-only config MUST remain nil; creating one can reset relay URLs.
	if config == nil || os.Getenv(configEnv) == "" {
		return config
	}
	result := proto.Clone(config).(*pb.NetbirdConfig)
	result.Flow = &pb.FlowConfig{Enabled: false, Interval: durationpb.New(time.Minute)}
	cfg, secret, err := readSettings()
	if err != nil || cfg == nil || !cfg.Enabled || !identifier.MatchString(peerID) ||
		!selected(cfg, peerID, groups) {
		return result
	}
	payload, signature := credentials(secret, peerID, now)
	result.Flow = &pb.FlowConfig{
		Url: strings.TrimSuffix(cfg.ReceiverURL, "/"), Enabled: true, Counters: cfg.Counters,
		Interval:     durationpb.New(time.Duration(cfg.IntervalSeconds) * time.Second),
		TokenPayload: payload, TokenSignature: signature,
	}
	return result
}
