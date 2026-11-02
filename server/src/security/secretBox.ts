import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * Seals short secrets such as Canvas tokens with AES-256-GCM. The `context` (the owner's user id)
 * is authenticated too, so a sealed value copied onto another user's row cannot be opened.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("The credentials key must be 32 bytes.");
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), body].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
  }

  /** Throws if the value was tampered with, sealed for another context or with another key. */
  open(sealed: string, context: string): string {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== VERSION || !iv || !tag || body === undefined) throw new Error("Unrecognized sealed value.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}
