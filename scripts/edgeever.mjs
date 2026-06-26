#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

const baseUrl = (process.env.EDGEEVER_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = process.env.EDGEEVER_TOKEN;
const [, , command, ...argv] = process.argv;

const usage = `EdgeEver CLI

Usage:
  EDGEEVER_TOKEN=... bun run cli -- notebooks
  EDGEEVER_TOKEN=... bun run cli -- tags
  EDGEEVER_TOKEN=... bun run cli -- search <query>
  EDGEEVER_TOKEN=... bun run cli -- get <memoId>
  EDGEEVER_TOKEN=... bun run cli -- create --notebook <id> [--title <title>] [--body <markdown> | --body-file <path>] [--tags a,b]
  EDGEEVER_TOKEN=... bun run cli -- update <memoId> [--title <title>] [--body <markdown> | --body-file <path>] [--tags a,b] [--notebook <id>]
`;

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}

if (!token) {
  console.error("EDGEEVER_TOKEN is required.");
  process.exit(1);
}

const main = async () => {
  switch (command) {
    case "notebooks":
      return printJson(await request("/api/v1/notebooks"));
    case "tags":
      return printJson(await request("/api/v1/tags"));
    case "search": {
      const query = argv.join(" ").trim();
      const params = new URLSearchParams();

      if (query) {
        params.set("q", query);
      }

      return printJson(await request(`/api/v1/memos?${params.toString()}`));
    }
    case "get": {
      const memoId = argv[0];
      requireValue(memoId, "memoId");
      return printJson(await request(`/api/v1/memos/${encodeURIComponent(memoId)}`));
    }
    case "create": {
      const options = parseOptions(argv);
      const notebookId = requireValue(options.notebook, "--notebook");
      const body = await readBodyOption(options);
      return printJson(
        await request("/api/v1/memos", {
          method: "POST",
          body: {
            notebookId,
            title: options.title,
            contentMarkdown: body,
            tags: parseTags(options.tags),
          },
        })
      );
    }
    case "update": {
      const memoId = argv[0];
      requireValue(memoId, "memoId");
      const options = parseOptions(argv.slice(1));
      const body = options.body || options["body-file"] ? await readBodyOption(options) : undefined;
      const payload = removeUndefined({
        title: options.title,
        notebookId: options.notebook,
        contentMarkdown: body,
        tags: options.tags === undefined ? undefined : parseTags(options.tags),
      });

      return printJson(
        await request(`/api/v1/memos/${encodeURIComponent(memoId)}`, {
          method: "PATCH",
          body: payload,
        })
      );
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(usage);
      process.exit(1);
  }
};

const request = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message = body?.error?.message || response.statusText;
    throw new Error(`${response.status} ${message}`);
  }

  return body;
};

const parseOptions = (args) => {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = args[index + 1];

    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return options;
};

const readBodyOption = async (options) => {
  if (options["body-file"]) {
    return readFile(options["body-file"], "utf8");
  }

  return options.body || "";
};

const parseTags = (value) =>
  value
    ? value
        .split(/[,，\s]+/)
        .map((tag) => tag.trim().replace(/^#/, ""))
        .filter(Boolean)
    : [];

const removeUndefined = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

const requireValue = (value, name) => {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
};

const printJson = (value) => {
  console.log(JSON.stringify(value, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
