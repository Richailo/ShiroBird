// SPDX-License-Identifier: AGPL-3.0-only
package shirobirdflow

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	pb "github.com/netbirdio/netbird/shared/management/proto"
	"google.golang.org/protobuf/proto"
)

func configure(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	secret := filepath.Join(dir, "secret")
	if err := os.WriteFile(secret, []byte("0123456789abcdef0123456789abcdef"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := settings{Enabled: true, ReceiverURL: "https://flows.example.invalid", SecretFile: secret,
		PeerIDs: []string{"peer-A"}, GroupIDs: []string{"group-A"}, IntervalSeconds: 60, Counters: true}
	data, _ := json.Marshal(cfg)
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(configEnv, path)
	return path
}

func TestPreservesRelayAndOriginal(t *testing.T) {
	configure(t)
	input := &pb.NetbirdConfig{Relay: &pb.RelayConfig{Urls: []string{"rels://relay.example"},
		TokenPayload: "relay-payload", TokenSignature: "relay-signature"}}
	original := proto.Clone(input)
	result := Extend("peer-A", nil, input)
	if !result.Flow.Enabled || !result.Flow.Counters {
		t.Fatal("selected peer not enabled")
	}
	if !proto.Equal(input, original) || !proto.Equal(input.Relay, result.Relay) {
		t.Fatal("flow extension changed original or relay configuration")
	}
}

func TestNilConfigStaysNil(t *testing.T) {
	configure(t)
	if Extend("peer-A", nil, nil) != nil {
		t.Fatal("map-only updates must remain nil")
	}
}

func TestUnconfiguredIsNoop(t *testing.T) {
	t.Setenv(configEnv, "")
	input := &pb.NetbirdConfig{}
	if Extend("peer-A", nil, input) != input {
		t.Fatal("disabled integration changed config")
	}
	if err := ValidateRefresh(false, 0); err != nil {
		t.Fatal(err)
	}
}

func TestExplicitSelectionAndRevocation(t *testing.T) {
	path := configure(t)
	if Extend("peer-B", nil, &pb.NetbirdConfig{}).Flow.Enabled {
		t.Fatal("unselected peer enabled")
	}
	if !Extend("peer-B", []string{"group-A"}, &pb.NetbirdConfig{}).Flow.Enabled {
		t.Fatal("selected group disabled")
	}
	if err := os.WriteFile(path, []byte("{\"enabled\":false}"), 0600); err != nil {
		t.Fatal(err)
	}
	if Extend("peer-A", nil, &pb.NetbirdConfig{}).Flow.Enabled {
		t.Fatal("revocation ignored")
	}
}

func TestInvalidConfigFailsClosed(t *testing.T) {
	path := configure(t)
	if err := os.WriteFile(path, []byte("invalid JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	if Extend("peer-A", nil, &pb.NetbirdConfig{}).Flow.Enabled {
		t.Fatal("invalid configuration enabled flow")
	}
	if ValidateRefresh(true, 12*time.Hour) == nil {
		t.Fatal("invalid startup configuration accepted")
	}
}

func TestUnsafeSettings(t *testing.T) {
	for _, change := range []func(*settings){
		func(s *settings) { s.ReceiverURL = "http://flows.example" },
		func(s *settings) { s.ReceiverURL = "https://user:password@flows.example" },
		func(s *settings) { s.ReceiverURL = "https://flows.example/path" },
		func(s *settings) { s.PeerIDs = nil; s.GroupIDs = nil },
		func(s *settings) { s.IntervalSeconds = 0 },
		func(s *settings) { s.SecretFile = "/definitely-missing-shirobird-test-secret" },
		func(s *settings) { s.PeerIDs = []string{"bad id"} },
	} {
		path := configure(t)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var cfg settings
		if err := json.Unmarshal(data, &cfg); err != nil {
			t.Fatal(err)
		}
		change(&cfg)
		data, err = json.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if Extend("peer-A", nil, &pb.NetbirdConfig{}).Flow.Enabled {
			t.Fatal("unsafe settings enabled telemetry")
		}
	}
}

func TestTrailingJSONRejected(t *testing.T) {
	path := configure(t)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, []byte("{}")...), 0600); err != nil {
		t.Fatal(err)
	}
	if ValidateRefresh(true, 12*time.Hour) == nil {
		t.Fatal("trailing configuration accepted")
	}
}

func TestRenewalLifetimeAndStableWindow(t *testing.T) {
	configure(t)
	now := time.Unix(1800000000, 0)
	first := extendAt("peer-A", nil, &pb.NetbirdConfig{}, now).Flow
	same := extendAt("peer-A", nil, &pb.NetbirdConfig{}, now.Add(time.Second)).Flow
	later := extendAt("peer-A", nil, &pb.NetbirdConfig{}, now.Add(9*time.Hour)).Flow
	if first.TokenSignature != same.TokenSignature {
		t.Fatal("unstable credential within window")
	}
	if first.TokenSignature == later.TokenSignature {
		t.Fatal("credential not renewed")
	}
	raw, err := base64.RawURLEncoding.DecodeString(first.TokenPayload)
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		PeerID string `json:"peer_id"`
		Exp    int64  `json:"exp"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.PeerID != "peer-A" || claims.Exp <= now.Add(23*time.Hour).Unix() ||
		claims.Exp > now.Add(24*time.Hour).Unix() {
		t.Fatal("invalid identity or lifetime")
	}
	mac := hmac.New(sha256.New, []byte("0123456789abcdef0123456789abcdef"))
	mac.Write([]byte(first.TokenPayload))
	signature, _ := base64.StdEncoding.DecodeString(first.TokenSignature)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		t.Fatal("invalid signature")
	}
}

func TestRefreshPrecondition(t *testing.T) {
	configure(t)
	for _, ttl := range []time.Duration{0, -time.Second, 17 * time.Hour} {
		if ValidateRefresh(true, ttl) == nil {
			t.Fatal("unsafe relay TTL accepted")
		}
	}
	if ValidateRefresh(false, 12*time.Hour) == nil {
		t.Fatal("missing refresh source accepted")
	}
	if err := ValidateRefresh(true, 12*time.Hour); err != nil {
		t.Fatal(err)
	}
}

func TestPythonReceiverCompatibility(t *testing.T) {
	configure(t)
	target := os.Getenv("SHIROBIRD_TEST_TOKEN_OUTPUT")
	if target == "" {
		t.Skip("cross-language fixture output not requested")
	}
	flow := Extend("peer-A", nil, &pb.NetbirdConfig{}).Flow
	data, _ := json.Marshal(map[string]string{"token": flow.TokenSignature + "." + flow.TokenPayload})
	if err := os.WriteFile(target, data, 0644); err != nil {
		t.Fatal(err)
	}
}
