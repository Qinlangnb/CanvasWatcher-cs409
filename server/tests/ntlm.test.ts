import { describe, expect, it } from "vitest";
import {
  authenticateMessage,
  challengeToken,
  detectAuthScheme,
  md4,
  negotiateMessage,
  ntlmV2Response,
  ntowfv1,
  ntowfv2,
  parseChallengeMessage,
  splitNtlmUsername,
} from "../src/sources/ntlm.js";

const hex = (value: string) => Buffer.from(value.replace(/\s+/g, ""), "hex");

describe("md4 (RFC 1320 test suite)", () => {
  it.each([
    ["", "31d6cfe0d16ae931b73c59d7e0c089c0"],
    ["a", "bde52cb31de33e46245e05fbdbd6fb24"],
    ["abc", "a448017aaf21d8525fc10ae87aa6729d"],
    ["message digest", "d9130a8164549fe818874806e1c7014b"],
    ["abcdefghijklmnopqrstuvwxyz", "d79e1c308aa5bbcdeea8ed63df412da9"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "e33b4ddc9c38f2199c3e7b164fcc0536"],
  ])("md4(%j)", (input, digest) => {
    expect(md4(Buffer.from(input, "latin1")).toString("hex")).toBe(digest);
  });
});

// MS-NLMP 4.2.1 common values and 4.2.4 NTLMv2 authentication.
describe("NTLMv2 (MS-NLMP 4.2.4 test vectors)", () => {
  const serverChallenge = hex("0123456789abcdef");
  const clientChallenge = hex("aaaaaaaaaaaaaaaa");
  const time = Buffer.alloc(8);
  // MsvAvNbDomainName "Domain", MsvAvNbComputerName "Server", MsvAvEOL.
  const targetInfo = hex(
    "02000c0044006f006d00610069006e00 01000c005300650072007600650072000000 0000",
  );

  it("derives NTOWFv1 and NTOWFv2", () => {
    expect(ntowfv1("Password").toString("hex")).toBe("a4f49c406510bdcab6824ee7c30fd852");
    expect(ntowfv2("Password", "User", "Domain").toString("hex")).toBe("0c868a403bfd7a93a3001ef22ef02e3f");
  });

  it("computes the LMv2 response, NTProofStr and session base key", () => {
    const response = ntlmV2Response(ntowfv2("Password", "User", "Domain"), serverChallenge, targetInfo, time, clientChallenge);
    expect(response.lmChallengeResponse.toString("hex")).toBe("86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa");
    expect(response.ntProofStr.toString("hex")).toBe("68cd0ab851e51c96aabc927bebef6a1c");
    expect(response.sessionBaseKey.toString("hex")).toBe("8de40ccadbc14a82f15cb0ad0de95ca3");
  });
});

function challenge(flags = 0xe28a8215, withTimestamp = false): Buffer {
  const name = Buffer.from("Domain", "utf16le");
  const pairs = [hex("02000c00"), Buffer.from("Domain", "utf16le")];
  if (withTimestamp) pairs.push(hex("07000800"), hex("0011223344556677"));
  pairs.push(hex("00000000"));
  const info = Buffer.concat(pairs);
  const message = Buffer.alloc(56 + name.length + info.length);
  Buffer.from("NTLMSSP\0", "latin1").copy(message, 0);
  message.writeUInt32LE(2, 8);
  message.writeUInt16LE(name.length, 12);
  message.writeUInt16LE(name.length, 14);
  message.writeUInt32LE(56, 16);
  message.writeUInt32LE(flags >>> 0, 20);
  hex("0123456789abcdef").copy(message, 24);
  message.writeUInt16LE(info.length, 40);
  message.writeUInt16LE(info.length, 42);
  message.writeUInt32LE(56 + name.length, 44);
  name.copy(message, 56);
  info.copy(message, 56 + name.length);
  return message;
}

describe("NTLM messages", () => {
  it("builds a negotiate message", () => {
    const message = negotiateMessage();
    expect(message.subarray(0, 8).toString("latin1")).toBe("NTLMSSP\0");
    expect(message.readUInt32LE(8)).toBe(1);
    expect(message.readUInt32LE(12) & 0x201).toBe(0x201);
  });

  it("parses a challenge and answers with a verifiable NTLMv2 authenticate message", () => {
    const parsed = parseChallengeMessage(challenge());
    expect(parsed.targetName).toBe("Domain");
    expect(parsed.serverChallenge.toString("hex")).toBe("0123456789abcdef");
    expect(parsed.timestamp).toBeNull();
    const message = authenticateMessage(parsed, { username: "EXAMPLE\\student", password: "test-only" }, {
      clientChallenge: hex("aaaaaaaaaaaaaaaa"),
      now: new Date(0),
    });
    expect(message.readUInt32LE(8)).toBe(3);
    const field = (index: number) => {
      const at = 12 + index * 8;
      const offset = message.readUInt32LE(at + 4);
      return message.subarray(offset, offset + message.readUInt16LE(at));
    };
    expect(field(2).toString("utf16le")).toBe("EXAMPLE");
    expect(field(3).toString("utf16le")).toBe("student");
    // What a server does: recompute NTProofStr from its copy of the password.
    const nt = field(1);
    const proof = ntlmV2Response(ntowfv2("test-only", "student", "EXAMPLE"), parsed.serverChallenge, parsed.targetInfo,
      nt.subarray(24, 32), nt.subarray(32, 40)).ntProofStr;
    expect(nt.subarray(0, 16).equals(proof)).toBe(true);
    expect(field(0).length).toBe(24);
  });

  it("uses the server timestamp and a zero LMv2 response when one is offered", () => {
    const parsed = parseChallengeMessage(challenge(undefined, true));
    expect(parsed.timestamp?.toString("hex")).toBe("0011223344556677");
    const message = authenticateMessage(parsed, { username: "student", password: "test-only" });
    const lmOffset = message.readUInt32LE(16);
    expect(message.subarray(lmOffset, lmOffset + 24).equals(Buffer.alloc(24))).toBe(true);
    const ntOffset = message.readUInt32LE(24);
    expect(message.subarray(ntOffset + 24, ntOffset + 32).toString("hex")).toBe("0011223344556677");
  });

  it("rejects malformed challenges", () => {
    expect(() => parseChallengeMessage(Buffer.from("not ntlm"))).toThrow("NTLM_BAD_CHALLENGE");
    const truncated = challenge();
    truncated.writeUInt32LE(4000, 44);
    expect(() => parseChallengeMessage(truncated)).toThrow("NTLM_BAD_CHALLENGE");
  });

  it("detects schemes and tokens", () => {
    expect(detectAuthScheme("NTLM")).toBe("NTLM");
    expect(detectAuthScheme(["Negotiate", "NTLM"])).toBe("NTLM");
    expect(detectAuthScheme("Negotiate")).toBe("Negotiate");
    expect(detectAuthScheme('Basic realm="ntlm"')).toBeNull();
    expect(detectAuthScheme(undefined)).toBeNull();
    expect(challengeToken("NTLM " + challenge().toString("base64"), "NTLM")?.equals(challenge())).toBe(true);
    expect(challengeToken("NTLM", "NTLM")).toBeNull();
  });

  it("splits Windows-style usernames", () => {
    expect(splitNtlmUsername({ username: "AD\\student", password: "" })).toEqual({ user: "student", domain: "AD" });
    expect(splitNtlmUsername({ username: "student", password: "" })).toEqual({ user: "student", domain: "" });
  });
});
