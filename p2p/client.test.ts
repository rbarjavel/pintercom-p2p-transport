import test from "node:test";
import assert from "node:assert/strict";
import { P2PIntercomClient } from "./client.ts";
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

test("p2p clients exchange authenticated messages over an encrypted libp2p stream", async () => {
  const previousKey = process.env.PI_INTERCOM_P2P_KEY;
  process.env.PI_INTERCOM_P2P_KEY = "test-shared-key-1234";
  const sender = new P2PIntercomClient();
  const receiver = new P2PIntercomClient();

  try {
    await sender.connect(registration("sender"), "sender-id");
    await receiver.connect(registration("receiver"), "receiver-id");

    // Make discovery deterministic in the test; production uses the same
    // announce handshake after mDNS emits peer:discovery.
    const senderNode = Reflect.get(sender, "node");
    const receiverNode = Reflect.get(receiver, "node");
    await senderNode.dial(receiverNode.getMultiaddrs());
    await Reflect.apply(Reflect.get(sender, "announceToPeer"), sender, [receiverNode.peerId]);
    await Reflect.apply(Reflect.get(receiver, "announceToPeer"), receiver, [senderNode.peerId]);

    assert.deepEqual((await sender.listSessions()).map((session) => session.id).sort(), ["receiver-id", "sender-id"]);

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
