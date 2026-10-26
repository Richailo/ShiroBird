// SPDX-License-Identifier: AGPL-3.0-only
// Run only in an isolated test container. This does not start a NetBird daemon.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/netbirdio/netbird/flow/client"
	pb "github.com/netbirdio/netbird/flow/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func main() {
	if len(os.Args) != 3 {
		panic("usage: native-client-probe RECEIVER_URL TEST_TOKEN_JSON")
	}
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	var fixture struct{ Token string }
	if err = json.Unmarshal(raw, &fixture); err != nil {
		panic(err)
	}
	parts := strings.SplitN(fixture.Token, ".", 2)
	if len(parts) != 2 {
		panic("invalid test credential")
	}
	sender, err := client.NewClient(os.Args[1], parts[1], parts[0], time.Minute)
	if err != nil {
		panic(err)
	}
	defer sender.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	eventID := bytes.Repeat([]byte("e"), 16)
	ack := make(chan bool, 2)
	go sender.Receive(ctx, time.Minute, func(msg *pb.FlowEventAck) error {
		if !bytes.Equal(msg.EventId, eventID) {
			return fmt.Errorf("unexpected acknowledgement")
		}
		select {
		case ack <- true:
		case <-ctx.Done():
		}
		return nil
	})
	event := &pb.FlowEvent{
		EventId: eventID, PublicKey: bytes.Repeat([]byte("k"), 32), Timestamp: timestamppb.Now(),
		FlowFields: &pb.FlowFields{FlowId: bytes.Repeat([]byte("f"), 16),
			Protocol: 6, Direction: pb.Direction_EGRESS,
			SourceIp: net.ParseIP("100.64.1.2").To4(), DestIp: net.ParseIP("100.64.1.3").To4(),
			ConnectionInfo: &pb.FlowFields_PortInfo{PortInfo: &pb.PortInfo{SourcePort: 50000, DestPort: 443}},
			NumOfStarts:    5, NumOfEnds: 4, NumOfDrops: 2, RxBytes: 1000, TxBytes: 2000,
			RxPackets: 10, TxPackets: 20},
	}
	for attempt := 0; attempt < 2; attempt++ {
		for {
			if ctx.Err() != nil {
				panic("native stream did not become ready")
			}
			if sender.Send(event) == nil {
				break
			}
			select {
			case <-time.After(20 * time.Millisecond):
			case <-ctx.Done():
			}
		}
		select {
		case <-ack:
		case <-ctx.Done():
			panic("native acknowledgement timeout")
		}
	}
	fmt.Println("Official NetBird flow client: authentication, handshake, event and retry ACK passed")
}
