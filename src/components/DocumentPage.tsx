"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Editor from "@/components/Editor";
import PageHeader, { type HeaderPage } from "@/components/PageHeader";
import SaveIndicator from "@/components/SaveIndicator";
import SearchDialog from "@/components/SearchDialog";
import { FocusBar, useFocusMode } from "@/components/FocusMode";
import { useAutosave } from "@/lib/useAutosave";
import { textStats, type TextStats } from "@/lib/writing";

const EMPTY_STATS: TextStats = {
  words: 0,
  characters: 0,
  charactersNoSpaces: 0,
  readingMinutes: 0,
};

export default function DocumentPage({
  page,
  readOnly = false,
  favorite,
}: {
  page: HeaderPage & { content: string | null };
  readOnly?: boolean;
  favorite?: boolean;
}) {
  const save = useCallback(
    (content: string) =>
      fetch(`/api/pages/${page.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    [page.id]
  );
  const { state, error, schedule, retry } = useAutosave(save);

  const [stats, setStats] = useState<TextStats>(EMPTY_STATS);
  const onStatsChange = useCallback((text: string) => setStats(textStats(text)), []);

  const focus = useFocusMode();

  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <PageHeader
        page={page}
        exportHref={`/api/pages/${page.id}/export`}
        exportLabel="Markdown"
        readOnly={readOnly}
        favorite={favorite}
        stats={stats}
        onEnterFocus={readOnly ? undefined : () => focus.setActive(true)}
        onSplit={page.archived ? undefined : () => setPickerOpen(true)}
        readHref={`/read/${page.id}`}
      />
      {/* Picking a second document navigates to /p/A?with=B - the split is a
          URL, not client state, so it survives reload and can be shared. */}
      <SearchDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        placeholder="Open beside this one…"
        queryPrefix="type:document"
        onSelect={(r) => {
          if (r.type === "document" && r.id !== page.id) {
            router.push(`/p/${page.id}?with=${r.id}`);
          }
        }}
      />
      <Editor
        content={page.content}
        editable={!page.archived && !readOnly}
        onChange={schedule}
        onStatsChange={onStatsChange}
        typewriter={focus.active && focus.settings.typewriter}
        pageId={page.id}
      />
      {!readOnly && <SaveIndicator state={state} error={error} onRetry={retry} />}
      {focus.active && (
        <FocusBar
          settings={focus.settings}
          update={focus.update}
          onExit={() => focus.setActive(false)}
          stats={stats}
        />
      )}
    </div>
  );
}
