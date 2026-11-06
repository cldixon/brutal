/** A stand-in for Cloudflare Access's signer: an RSA key and RS256 tokens, for tests. */
export async function accessSigner(kid = "test-key") {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  const b64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const part = (o: object) => b64(new TextEncoder().encode(JSON.stringify(o)));
  return {
    jwk: jwk as JsonWebKey,
    async sign(payload: Record<string, unknown>, header: Record<string, unknown> = {}) {
      const head = part({ alg: "RS256", kid, ...header });
      const body = part(payload);
      const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return `${head}.${body}.${b64(new Uint8Array(sig))}`;
    },
  };
}
