const http = require("node:http"),
  crypto = require("node:crypto");
async function oauthServer(options = {}) {
  const calls = [],
    codes = new Map();
  let issuer, resource, base;
  let sequence = 0,
    refreshCount = 0;
  const json = (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const b of req) raw += b;
      const u = new URL(req.url, base);
      calls.push({
        path: u.pathname,
        method: req.method,
        body: raw,
        headers: req.headers,
      });
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        if (options.challenge) {
          res.writeHead(404);
          res.end();
          return;
        }
        return json(res, {
          resource: options.badResource ? base + "/wrong" : resource,
          authorization_servers: options.multipleIssuers
            ? [issuer, base + "/other"]
            : [issuer],
        });
      }
      if (u.pathname === "/mcp") {
        if (
          options.mcp &&
          req.headers.authorization ===
            `Bearer ${options.tokenPrefix ?? "owned-access-"}${refreshCount}`
        ) {
          const q = JSON.parse(raw);
          if (q.id == null) {
            res.writeHead(202);
            res.end();
            return;
          }
          if (options.rejectTool401 && q.method === "tools/call") {
            res.writeHead(401);
            res.end();
            return;
          }
          const result =
            q.method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "Owned OAuth MCP", version: "1" },
                }
              : q.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "echo",
                        description: "Owned authenticated echo",
                        inputSchema: {
                          type: "object",
                          properties: { text: { type: "string" } },
                          required: ["text"],
                          additionalProperties: false,
                        },
                      },
                    ],
                  }
                : {
                    content: [
                      {
                        type: "text",
                        text: "authorized:" + q.params.arguments.text,
                      },
                    ],
                  };
          return json(res, { jsonrpc: "2.0", id: q.id, result });
        }
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/resource-metadata"`,
        });
        res.end();
        return;
      }
      if (u.pathname === "/resource-metadata")
        return json(res, { resource, authorization_servers: [issuer] });
      if (u.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        if (options.discoveryDelay)
          await new Promise((r) => setTimeout(r, options.discoveryDelay));
        return json(res, {
          issuer: options.badIssuer ? base + "/wrong" : issuer,
          authorization_endpoint: base + "/authorize",
          token_endpoint: base + "/token",
          registration_endpoint: options.noRegistration
            ? undefined
            : base + "/register",
          revocation_endpoint: options.noRevoke ? undefined : base + "/revoke",
          code_challenge_methods_supported: options.noPkce
            ? ["plain"]
            : ["S256"],
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: options.authMethods ?? [
            "none",
            "client_secret_basic",
            "client_secret_post",
          ],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (u.pathname === "/register") {
        const request = JSON.parse(raw);
        return json(
          res,
          {
            client_id: "owned-dynamic-client",
            token_endpoint_auth_method: "none",
            redirect_uris: request.redirect_uris,
          },
          201,
        );
      }
      if (u.pathname === "/authorize") {
        const code = "owned-code-" + ++sequence;
        codes.set(code, {
          challenge: u.searchParams.get("code_challenge"),
          redirect: u.searchParams.get("redirect_uri"),
          client: u.searchParams.get("client_id"),
        });
        const target = new URL(u.searchParams.get("redirect_uri"));
        target.searchParams.set("state", u.searchParams.get("state"));
        target.searchParams.set("iss", issuer);
        if (options.denied) target.searchParams.set("error", "access_denied");
        else target.searchParams.set("code", code);
        res.writeHead(302, { location: target.href });
        res.end();
        return;
      }
      if (u.pathname === "/token") {
        const p = new URLSearchParams(raw);
        let client = p.get("client_id");
        if (req.headers.authorization) {
          const text = Buffer.from(
            req.headers.authorization.slice(6),
            "base64",
          ).toString();
          const n = text.indexOf(":");
          client = decodeURIComponent(text.slice(0, n).replaceAll("+", " "));
          const secret = decodeURIComponent(
            text.slice(n + 1).replaceAll("+", " "),
          );
          if (secret !== options.clientSecret)
            return json(res, { error: "invalid_client" }, 401);
        } else if (
          options.authMethods?.[0] === "client_secret_post" &&
          p.get("client_secret") !== options.clientSecret
        )
          return json(res, { error: "invalid_client" }, 401);
        if (p.get("resource") !== resource)
          return json(res, { error: "wrong_resource" }, 400);
        if (p.get("grant_type") === "authorization_code") {
          const saved = codes.get(p.get("code"));
          codes.delete(p.get("code"));
          if (
            !saved ||
            crypto
              .createHash("sha256")
              .update(p.get("code_verifier") ?? "")
              .digest("base64url") !== saved.challenge ||
            saved.redirect !== p.get("redirect_uri") ||
            saved.client !== client
          )
            return json(res, { error: "invalid_grant" }, 400);
        } else {
          refreshCount++;
          if (options.invalidGrant)
            return json(
              res,
              { error: "invalid_grant", detail: "must-not-echo-private-token" },
              400,
            );
          if (options.refreshFailure)
            return json(res, { error: "fixture_failure" }, 503);
          if (p.get("refresh_token") !== `owned-refresh-${refreshCount - 1}`)
            return json(res, { error: "invalid_grant" }, 400);
        }
        if (options.tokenDelay)
          await new Promise((r) => setTimeout(r, options.tokenDelay));
        if (options.hangRefresh && p.get("grant_type") === "refresh_token")
          return;
        return json(res, {
          access_token:
            (options.tokenPrefix ??
              (options.longToken ? "x".repeat(6000) : "owned-access-")) +
            refreshCount,
          refresh_token: options.noRefresh
            ? undefined
            : `owned-refresh-${refreshCount}`,
          token_type: options.badTokenType ? "MAC" : "Bearer",
          expires_in: 3600,
          scope: options.broadScope ? "unexpected" : "files.read",
        });
      }
      if (u.pathname === "/revoke") {
        if (options.revokeDelay)
          await new Promise((r) => setTimeout(r, options.revokeDelay));
        if (options.revokeFailure) {
          res.writeHead(503);
          res.end("must-not-echo-private-token");
          return;
        }
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end("owned fixture failed");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  issuer = base + "/issuer";
  resource = base + "/mcp";
  return {
    base,
    issuer,
    resource,
    calls,
    options,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}
module.exports = { oauthServer };
