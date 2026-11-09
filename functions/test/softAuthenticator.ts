/**
 * Minimal software WebAuthn authenticator (ES256, "none" attestation) for tests.
 * Produces genuine registration and assertion responses so the server's real
 * @simplewebauthn verification runs end to end.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

function cborBytes(b: Buffer) {
  if (b.length < 24) return Buffer.concat([Buffer.from([0x40 + b.length]), b]);
  if (b.length < 256) return Buffer.concat([Buffer.from([0x58, b.length]), b]);
  return Buffer.concat([Buffer.from([0x59, b.length >> 8, b.length & 0xff]), b]);
}
const cborText = (s: string) => Buffer.concat([Buffer.from([0x60 + s.length]), Buffer.from(s)]);

export class SoftAuthenticator {
  readonly credentialId = b64u(randomBytes(16));
  private readonly privateKey: KeyObject;
  private readonly cose: Buffer;
  private counter = 0;

  constructor(
    private origin: string,
    private rpID = new URL(origin).hostname,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
    this.cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  register(challenge: string, opts: { uv?: boolean } = {}) {
    const flags = 0x01 | (opts.uv === false ? 0 : 0x04) | 0x40;
    const credId = Buffer.from(this.credentialId, 'base64url');
    const authData = Buffer.concat([
      sha256(this.rpID),
      Buffer.from([flags]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.alloc(16),
      Buffer.from([credId.length >> 8, credId.length & 0xff]),
      credId,
      this.cose,
    ]);
    const attestationObject = Buffer.concat([Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]), cborText('authData'), cborBytes(authData)]);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: { clientDataJSON: b64u(this.clientData('webauthn.create', challenge)), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  assert(challenge: string, opts: { uv?: boolean } = {}) {
    this.counter++;
    const flags = 0x01 | (opts.uv === false ? 0 : 0x04);
    const authData = Buffer.concat([sha256(this.rpID), Buffer.from([flags]), Buffer.from([0, 0, 0, this.counter])]);
    const clientDataJSON = this.clientData('webauthn.get', challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: { authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
