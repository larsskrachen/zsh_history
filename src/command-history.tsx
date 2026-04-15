import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { homedir } from "os";
import { readFile } from "fs/promises";
import { byStartAsc, extendedMatch, Fzf } from "fzf";

const HISTORY_PATH = `${homedir()}/.zsh_history`;
const MAX_HISTORY_ITEMS = 10000;
const MAX_VISIBLE_ITEMS = 300;

interface HistoryItem {
  command: string;
  timestamp?: number;
  duration?: number;
}

function parseHistoryLine(line: string): HistoryItem | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  // zsh extended history format: ": 1712747243:0;git status"
  const separatorIndex = trimmed.indexOf(";");
  if (trimmed.startsWith(": ") && separatorIndex !== -1) {
    const metadataStr = trimmed.slice(2, separatorIndex);
    const metadataParts = metadataStr.split(":");
    const timestamp = parseInt(metadataParts[0], 10);
    const duration = metadataParts.length > 1 ? parseInt(metadataParts[1], 10) : undefined;
    const command = trimmed.slice(separatorIndex + 1).trim();
    if (!command) {
      return null;
    }
    return {
      command,
      timestamp: isNaN(timestamp) ? undefined : timestamp,
      duration: isNaN(duration as number) ? undefined : duration,
    };
  }

  return { command: trimmed };
}

function getRelativeTime(timestamp?: number): string | null {
  if (!timestamp) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) {
    return "gerade eben";
  }
  if (diff < 3600) {
    return `vor ${Math.floor(diff / 60)} Min.`;
  }
  if (diff < 86400) {
    return `vor ${Math.floor(diff / 3600)} Std.`;
  }
  if (diff < 2592000) {
    return `vor ${Math.floor(diff / 86400)} Tg.`;
  }
  if (diff < 31536000) {
    return `vor ${Math.floor(diff / 2592000)} Mon.`;
  }
  return `vor ${Math.floor(diff / 31536000)} J.`;
}

async function loadZshHistory(): Promise<HistoryItem[]> {
  const raw = await readFile(HISTORY_PATH, "utf8");
  const lines = raw.split(/\r?\n/);

  const unique = new Set<string>();
  const items: HistoryItem[] = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const item = parseHistoryLine(lines[i]);
    if (!item || unique.has(item.command)) {
      continue;
    }

    unique.add(item.command);
    items.push(item);

    if (items.length >= MAX_HISTORY_ITEMS) {
      break;
    }
  }

  return items;
}

async function fzfFilter(items: HistoryItem[], query: string): Promise<HistoryItem[]> {
  if (!query.trim()) {
    return items.slice(0, MAX_VISIBLE_ITEMS);
  }

  const fzf = new Fzf(items, {
    selector: (item) => item.command,
    casing: "smart-case",
    fuzzy: false,
    match: extendedMatch,
    tiebreakers: [byStartAsc],
  });

  const results = fzf.find(query);
  return results.map((r) => r.item).slice(0, MAX_VISIBLE_ITEMS);
}

export default function Command() {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [results, setResults] = useState<HistoryItem[]>([]);
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
        setErrorText(`Suche fehlgeschlagen: ${message}`);
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
      searchBarPlaceholder="Suche in zsh history"
      onSearchTextChange={setSearchText}
      filtering={false}
      throttle
      isShowingDetail
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
          {results.map((item, index) => {
            const relativeTime = getRelativeTime(item.timestamp);
            return (
              <List.Item
                key={`${item.command}-${index}`}
                title={item.command}
                icon={Icon.Terminal}
                accessories={[{ text: relativeTime ?? `${index + 1}`, icon: item.timestamp ? Icon.Clock : undefined }]}
                detail={
                  <List.Item.Detail
                    markdown={`\`\`\`bash\n${item.command}\n\`\`\``}
                    metadata={
                      <List.Item.Detail.Metadata>
                        {item.timestamp && (
                          <>
                            <List.Item.Detail.Metadata.Label
                              title="Ausgeführt am"
                              text={new Date(item.timestamp * 1000).toLocaleString()}
                            />
                            <List.Item.Detail.Metadata.Label
                              title="Relative Zeit"
                              text={getRelativeTime(item.timestamp) ?? "unbekannt"}
                            />
                          </>
                        )}
                        <List.Item.Detail.Metadata.Separator />
                      </List.Item.Detail.Metadata>
                    }
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.Paste title="In aktives Fenster einfügen" content={item.command} />
                    <Action.CopyToClipboard title="In Zwischenablage Kopieren" content={item.command} />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
