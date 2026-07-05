// AI-drafted descriptions. Reads (small) file contents and asks a chat model
// for a one-line summary of each file's role, batched to keep prompts small.

import type { Services } from './host';
import type { DescriptionEntry } from './explorerFile';
import { absJoin } from './paths';
import { hashContent, isProbablyBinary } from './scan';

const MAX_CONTENT_CHARS = 1500;
const BATCH_SIZE = 12;

const SYSTEM_PROMPT =
  'You document codebases. For each file provided, write ONE concise sentence ' +
  '(max ~20 words) describing what the file does and its role in the project. ' +
  'Base it on the path and any content given. Respond with ONLY a JSON object ' +
  'mapping each given file path (verbatim) to its description string.';

export interface DescribeProgress {
  done: number;
  total: number;
}

/**
 * Generate descriptions for the given workspace-relative file paths.
 * Returns a map of path -> description entry (with a content hash captured
 * at read time, so later edits to the file can be detected as making the
 * description stale) for the files the model answered.
 */
export async function generateDescriptions(
  services: Services,
  rootPosix: string,
  relPaths: string[],
  onProgress?: (p: DescribeProgress) => void,
): Promise<Record<string, DescriptionEntry>> {
  const ai = services.ai;
  if (!ai) throw new Error('AI is not available. Enable an AI provider in settings.');

  const result: Record<string, DescriptionEntry> = {};
  const total = relPaths.length;
  let done = 0;

  for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
    const batch = relPaths.slice(i, i + BATCH_SIZE);
    const items: Array<{ path: string; content: string; hash?: string }> = [];

    for (const rel of batch) {
      let content = '';
      let hash: string | undefined;
      if (!isProbablyBinary(rel)) {
        try {
          const raw = await services.filesystem.readFile(absJoin(rootPosix, rel));
          hash = hashContent(raw);
          content = raw.slice(0, MAX_CONTENT_CHARS);
        } catch {
          // Unreadable file: describe from the path alone. No hash, so this
          // entry is never flagged stale later.
        }
      }
      items.push({ path: rel, content, hash });
    }

    const userPayload = items
      .map((it) => `PATH: ${it.path}\n${it.content ? `CONTENT:\n${it.content}` : '(no readable text content)'}`)
      .join('\n\n---\n\n');

    const completion = await ai.chatCompletion({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPayload }],
      temperature: 0,
      responseFormat: { type: 'json_object' },
    });

    const texts = parseDescriptionMap(completion.content, batch);
    const hashByPath = new Map(items.map((it) => [it.path, it.hash]));
    for (const [path, text] of Object.entries(texts)) {
      const hash = hashByPath.get(path);
      result[path] = hash ? { text, hash } : { text };
    }

    done += batch.length;
    onProgress?.({ done, total });
  }

  return result;
}

function parseDescriptionMap(content: string, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const allow = new Set(allowed);
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (allow.has(key) && typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    }
  }
  return out;
}
