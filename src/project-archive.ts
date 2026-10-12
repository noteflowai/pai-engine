/**
 * Archiving a design task hides it from the default task list; it changes nothing else (records, requirement
 * versions, evidence and releases stay; nothing is deleted). Reversible: unarchive. One record per task, the latest
 * decision with who, when and why.
 */
import { z } from "zod";
import { DomainError } from "./domain.js";
import type { Store } from "./store.js";

export interface ProjectArchive { id: string; projectId: string; archived: boolean; reason: string; at: string; by: string; revision?: number }
export const ArchiveTask = z.object({ archived: z.boolean(), reason: z.string().trim().min(5).max(500) }).strict();

export function archiveTask(store: Store, projectId: string, input: unknown, actor: string): ProjectArchive {
  const req = ArchiveTask.parse(input);
  if (!store.get("project", projectId)) throw new DomainError("NOT_FOUND", "No such task", 404);
  const prev = store.get<ProjectArchive>("project-archive", projectId);
  const next: ProjectArchive = { id: projectId, projectId, archived: req.archived, reason: req.reason, at: new Date().toISOString(), by: actor };
  if (prev) store.put("project-archive", { ...next, revision: (prev.revision ?? 1) + 1 }, prev.revision ?? 1);
  else store.insert("project-archive", next);
  return store.get<ProjectArchive>("project-archive", projectId)!;
}
