import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { homedir } from "os";
import { readFile } from "fs/promises";
import { spawn } from "child_process";

const HISTORY_PATH = `${homedir()}/.zsh_history`;
const MAX_HISTORY_ITEMS = 10000;
const MAX_VISIBLE_ITEMS = 300;

function parseHistoryLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  // zsh extended history format: ": 1712747243:0;git status"
  const separatorIndex = trimmed.indexOf(";");
  if (trimmed.startsWith(": ") && separatorIndex !== -1) {
    const command = trimmed.slice(separatorIndex + 1).trim();
    return command || null;
  }

  return trimmed;
}

async function loadZshHistory(): Promise<string[]> {
  const raw = await readFile(HISTORY_PATH, "utf8");
  const lines = raw.split(/\r?\n/);

  const unique = new Set<string>();
  const commands: string[] = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const command = parseHistoryLine(lines[i]);
    if (!command || unique.has(command)) {
      continue;
    }

    unique.add(command);
    commands.push(command);

    if (commands.length >= MAX_HISTORY_ITEMS) {
      break;
    }
  }

  return commands;
}

async function fzfFilter(items: string[], query: string): Promise<string[]> {
  if (!query.trim()) {
    return items.slice(0, MAX_VISIBLE_ITEMS);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("fzf", ["--filter", query, "--smart-case"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${homedir()}/.fzf/bin`, process.env.PATH]
          .filter(Boolean)
          .join(":"),
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
    });

    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));

    child.on("error", (error) => reject(error));

    child.on("close", (code) => {
      if (code === 1) {
        // fzf returns 1 if no match is found
        resolve([]);
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(errorChunks).toString("utf8").trim();
        reject(new Error(stderr || `fzf failed with code ${code}`));
        return;
      }

      const output = Buffer.concat(chunks).toString("utf8");
      const results = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MAX_VISIBLE_ITEMS);

      resolve(results);
    });

    child.stdin.on("error", (err) => {
      if ("code" in err && err.code !== "EPIPE") {
        console.error("Stdin error:", err);
      }
    });

    child.stdin.end(items.join("\n"));
  });
}

export default function Command() {
  const [history, setHistory] = useState<string[]>([]);
  const [results, setResults] = useState<string[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        const loaded = await loadZshHistory();
        if (cancelled) {
          return;
        }

        setHistory(loaded);
        setResults(loaded.slice(0, MAX_VISIBLE_ITEMS));
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unknown error";
        setErrorText(`Konnte ${HISTORY_PATH} nicht lesen: ${message}`);
        await showToast({
          style: Toast.Style.Failure,
          title: "zsh history konnte nicht geladen werden",
          message,
        });
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void initialize();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function updateResults() {
      if (history.length === 0) {
        setResults([]);
        return;
      }

      setIsLoading(true);
      try {
        const filtered = await fzfFilter(history, searchText);
        if (!cancelled) {
          setResults(filtered);
          setErrorText(null);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unknown error";
        const help = message.includes("ENOENT")
          ? "fzf nicht gefunden. Installiere es mit: brew install fzf"
          : `fzf Fehler: ${message}`;

        setErrorText(help);
        setResults(searchText.trim() ? [] : history.slice(0, MAX_VISIBLE_ITEMS));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    const timeout = setTimeout(() => {
      void updateResults();
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [history, searchText]);

  const subtitle = useMemo(() => {
    if (errorText) {
      return errorText;
    }

    return `Treffer: ${results.length} / Gesamt: ${history.length}`;
  }, [errorText, results.length, history.length]);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Suche in zsh history (fzf)"
      onSearchTextChange={setSearchText}
      filtering={false}
      throttle
    >
      {errorText && results.length === 0 ? (
        <List.EmptyView title="Fehler" description={errorText} icon={Icon.ExclamationMark} />
      ) : results.length === 0 && !isLoading ? (
        <List.EmptyView
          title={searchText ? "Keine Treffer" : "History geladen"}
          description={searchText ? `Keine Befehle für "${searchText}" gefunden.` : "Fang an zu tippen, um zu suchen."}
          icon={searchText ? Icon.MagnifyingGlass : Icon.Terminal}
        />
      ) : (
        <List.Section title="zsh history" subtitle={subtitle}>
          {results.map((command, index) => (
            <List.Item
              key={`${command}-${index}`}
              title={command}
              icon={Icon.Terminal}
              accessories={[{ text: `${index + 1}` }]}
              actions={
                <ActionPanel>
                  <Action.Paste title="In Aktive App Einfuegen" content={command} />
                  <Action.CopyToClipboard title="In Zwischenablage Kopieren" content={command} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
