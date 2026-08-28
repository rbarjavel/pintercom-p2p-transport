import test from "node:test";
import assert from "node:assert/strict";
import { confirmP2PListenAddresses, p2pMdnsAnswers, P2PIntercomClient } from "./client.ts";
import type { SessionRegistration } from "../types.ts";

function registration(name: string): SessionRegistration {
  return {
    name,
    cwd: process.cwd(),
    model: "test",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

test("p2p confirms every bound address for link-local mDNS advertisement", () => {
  const addresses = [{ id: "loopback" }, { id: "public-range-lan" }];
  const confirmed: Array<{ address: unknown; type: string }> = [];

  confirmP2PListenAddresses({
    transportManager: { getAddrs: () => addresses },
    addressManager: {
      confirmObservedAddr: (address, { type }) => confirmed.push({ address, type }),
    },
  } as never);

  assert.deepEqual(confirmed, addresses.map((address) => ({ address, type: "transport" })));
});

test("p2p mDNS advertises bound public-range LAN addresses", () => {
  const answers = p2pMdnsAnswers("_pi-intercom._udp.local", "peer", [
    { toString: () => "/ip4/70.0.0.138/tcp/52180/p2p/peer" },
  ]);

  assert.equal(answers[1]?.data, "dnsaddr=/ip4/70.0.0.138/tcp/52180/p2p/peer");
});

test("p2p clients exchange authenticated messages over an encrypted libp2p stream", async () => {
  const previousKey = process.env.PI_INTERCOM_P2P_KEY;
  process.env.PI_INTERCOM_P2P_KEY = "test-shared-key-1234";
  const sender = new P2PIntercomClient();
  const receiver = new P2PIntercomClient();

  try {
    await sender.connect(registration("sender"), "sender-id");
    await receiver.connect({
      ...registration("receiver"),
      hostname: "remote-device",
      os: "Linux arm64",
      sshRemote: "root@device.local",
    }, "receiver-id");

    // Make discovery deterministic in the test; production uses the same
    // announce handshake after mDNS emits peer:discovery.
    const senderNode = Reflect.get(sender, "node");
    const receiverNode = Reflect.get(receiver, "node");
    await senderNode.dial(receiverNode.getMultiaddrs());
    await Reflect.apply(Reflect.get(sender, "announceToPeer"), sender, [receiverNode.peerId]);
    await Reflect.apply(Reflect.get(receiver, "announceToPeer"), receiver, [senderNode.peerId]);

    const sessions = await sender.listSessions();
    assert.deepEqual(sessions.map((session) => session.id).sort(), ["receiver-id", "sender-id"]);
    assert.partialDeepStrictEqual(sessions.find((session) => session.id === "receiver-id"), {
      hostname: "remote-device",
      os: "Linux arm64",
      sshRemote: "root@device.local",
    });

    const received = new Promise<string>((resolve) => {
      receiver.once("message", (_from, message) => resolve(message.content.text));
    });
    const result = await sender.send("receiver-id", { text: "hello over p2p" });

    assert.equal(result.delivered, true);
    assert.equal(await received, "hello over p2p");
  } finally {
    await Promise.allSettled([sender.disconnect(), receiver.disconnect()]);
    if (previousKey === undefined) delete process.env.PI_INTERCOM_P2P_KEY;
    else process.env.PI_INTERCOM_P2P_KEY = previousKey;
  }
});
