const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../../..");
const digest = (value) =>
  "sha256:" + crypto.createHash("sha256").update(value).digest("hex");

async function fixture(t, location, corrupt = false) {
  const module = await import(
    pathToFileURL(path.join(root, "scripts/verify-local-docker-image.mjs")).href
  );
  const parent = path.join(root, ".tmp-image-provenance");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => {
    assert.equal(path.dirname(directory), parent);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = Buffer.from(
    JSON.stringify({
      os: "linux",
      architecture: "amd64",
      config: { Entrypoint: ["/usr/local/bin/start-sand-box"] },
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        size: config.length,
        digest: digest(config),
      },
    }),
  );
  const sourcePath = path.join(directory, "source.ts");
  fs.writeFileSync(
    sourcePath,
    `export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal@${digest(manifest)}";\n`,
  );
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    if (parsed.hostname === "public.ecr.aws") {
      if (parsed.pathname === "/token/")
        return Response.json({ token: "owned-registry-token" });
      assert.equal(
        options.headers.Authorization,
        "Bearer owned-registry-token",
      );
      if (parsed.pathname.includes("/manifests/"))
        return new Response(manifest, {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
          },
        });
      assert.equal(parsed.pathname.endsWith(digest(config)), true);
      return new Response(null, { status: 307, headers: { location } });
    }
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, "error");
    const bytes = Buffer.from(config);
    if (corrupt) bytes[0] ^= 1;
    return new Response(bytes);
  };
  return {
    run: () => module.verifyPinnedLocalDockerImage({ sourcePath, fetchImpl }),
    requests,
    config,
  };
}

for (const host of [
  "d5l0dvt14r5h8.cloudfront.net",
  "d2glxqk2uabbnd.cloudfront.net",
]) {
  test(`ECR verifies pinned config through ${host} without forwarding registry credentials`, async (t) => {
    const h = await fixture(t, `https://${host}/v2/config?signature=owned`);
    const result = await h.run();
    assert.equal(result.configDigest, digest(h.config));
    assert.equal(h.requests.length, 4);
  });
}

for (const location of [
  "https://other.cloudfront.net/config",
  "https://d2glxqk2uabbnd.cloudfront.net.evil.invalid/config",
  "http://d2glxqk2uabbnd.cloudfront.net/config",
  "https://user:secret@d2glxqk2uabbnd.cloudfront.net/config?secret-query",
  "https://d2glxqk2uabbnd.cloudfront.net:4443/config",
  "https://d2glxqk2uabbnd.cloudfront.net/config#fragment",
]) {
  test(`ECR rejects an unapproved redirect boundary ${new URL(location).origin}`, async (t) => {
    const h = await fixture(t, location);
    await assert.rejects(h.run, (error) => {
      assert.match(error.message, /outside the approved HTTPS CloudFront host/);
      assert.equal(error.message.includes("secret"), false);
      assert.equal(error.message.includes("fragment"), false);
      return true;
    });
    assert.equal(h.requests.length, 3);
  });
}

test("ECR rejects modified config bytes returned by an approved CDN", async (t) => {
  const h = await fixture(
    t,
    "https://d5l0dvt14r5h8.cloudfront.net/config",
    true,
  );
  await assert.rejects(h.run, /bytes do not match its manifest descriptor/);
});
