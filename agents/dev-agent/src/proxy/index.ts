/**
 * JWT proxy framework for sandbox credential isolation.
 * The sandbox gets a short-lived JWT; when it calls back to the Worker's
 * /proxy/<service>/* endpoint, the Worker validates the JWT and injects
 * the real credential before forwarding to the external API.
 */

export interface ServiceConfig {
	target: string;
	validate: (req: Request) => string | null;
	transform: (
		req: Request,
		ctx: { env: Env; jwt: JwtPayload }
	) => Promise<Request | Response>;
}

export interface JwtPayload {
	sandboxId: string;
	iat: number;
	exp: number;
}

export function createProxyHandler(opts: {
	mountPath: string;
	jwtSecret: (env: Env) => string | undefined;
	services: Record<string, ServiceConfig>;
}) {
	return async (request: Request, env: Env): Promise<Response> => {
		const secret = opts.jwtSecret(env);
		if (!secret) {
			return new Response("Proxy not configured", { status: 503 });
		}

		const url = new URL(request.url);
		const pathAfterMount = url.pathname.slice(opts.mountPath.length);

		// Extract service name: /proxy/anthropic/v1/messages -> serviceName = "anthropic"
		const slashIdx = pathAfterMount.indexOf("/", 1);
		const serviceName = slashIdx > 0
			? pathAfterMount.slice(1, slashIdx)
			: pathAfterMount.slice(1);

		const service = opts.services[serviceName];
		if (!service) {
			return new Response(`Unknown proxy service: ${serviceName}`, { status: 404 });
		}

		// Extract and validate JWT
		const token = service.validate(request);
		if (!token) {
			return new Response("Missing or invalid credentials", { status: 401 });
		}

		let jwt: JwtPayload;
		try {
			jwt = await verifyJwt(token, secret);
		} catch {
			return new Response("Invalid or expired token", { status: 401 });
		}

		// Rewrite the URL to the target service
		const targetPath = slashIdx > 0 ? pathAfterMount.slice(slashIdx) : "/";
		const targetUrl = new URL(targetPath, service.target);
		targetUrl.search = url.search;

		const outgoing = new Request(targetUrl.toString(), {
			method: request.method,
			headers: new Headers(request.headers),
			body: request.body,
		});

		// Let the service transform (inject real credentials)
		const result = await service.transform(outgoing, { env, jwt });

		if (result instanceof Response) {
			return result;
		}

		return fetch(result);
	};
}

export async function createProxyToken(opts: {
	secret: string;
	sandboxId: string;
	expiresInSeconds?: number;
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const { PROXY_JWT_DEFAULT_TTL_SECONDS } = await import("../config/constants");
	const exp = now + (opts.expiresInSeconds ?? PROXY_JWT_DEFAULT_TTL_SECONDS);

	const payload: JwtPayload = {
		sandboxId: opts.sandboxId,
		iat: now,
		exp,
	};

	return signJwt(payload, opts.secret);
}

// Minimal JWT implementation using Web Crypto (no dependencies)

async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
	const header = { alg: "HS256", typ: "JWT" };
	const encodedHeader = base64UrlEncode(JSON.stringify(header));
	const encodedPayload = base64UrlEncode(JSON.stringify(payload));

	const data = `${encodedHeader}.${encodedPayload}`;
	const key = await importKey(secret);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));

	return `${data}.${base64UrlEncodeBuffer(signature)}`;
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid JWT format");

	const [header, payload, sig] = parts;
	const data = `${header}.${payload}`;
	const key = await importKey(secret);

	const signatureBuffer = base64UrlDecodeBuffer(sig);
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		signatureBuffer,
		new TextEncoder().encode(data)
	);

	if (!valid) throw new Error("Invalid JWT signature");

	const decoded = JSON.parse(base64UrlDecode(payload)) as JwtPayload;

	const now = Math.floor(Date.now() / 1000);
	if (decoded.exp && decoded.exp < now) throw new Error("JWT expired");

	return decoded;
}

async function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"]
	);
}

function base64UrlEncode(str: string): string {
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/");
	return atob(padded);
}

function base64UrlEncodeBuffer(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeBuffer(str: string): ArrayBuffer {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}
