import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { keymap } from "@codemirror/view";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export interface JsonCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void | Promise<void>;
  originalValue?: string;
  title?: string;
  description?: string;
  isSaving?: boolean;
  minHeight?: string;
  maxHeight?: string;
  height?: string;
  readOnly?: boolean;
  className?: string;
  showToolbar?: boolean;
}

export function JsonCodeEditor({
  value,
  onChange,
  onSave,
  originalValue,
  title,
  description,
  isSaving = false,
  minHeight,
  maxHeight,
  height = "100%",
  readOnly = false,
  className,
  showToolbar = true,
}: JsonCodeEditorProps) {
  const codeTheme = experimental_useCodeTheme();
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const [parseError, setParseError] = useState<string | null>(null);

  // Validate JSON whenever value changes
  useEffect(() => {
    if (!value.trim()) {
      setParseError(null);
      return;
    }
    try {
      JSON.parse(value);
      setParseError(null);
    } catch (err: any) {
      setParseError(err.message || "Invalid JSON");
    }
  }, [value]);

  const handleFormat = useCallback(() => {
    try {
      const parsed = JSON.parse(value);
      const formatted = JSON.stringify(parsed, null, 2);
      onChange(formatted);
      toast.success("JSON formatted");
    } catch (err: any) {
      toast.error(`Cannot format invalid JSON: ${err.message}`);
    }
  }, [value, onChange]);

  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        toast.success("Copied to clipboard");
      }
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  }, [value]);

  const handleReset = useCallback(() => {
    if (originalValue !== undefined) {
      onChange(originalValue);
      toast.info("Reset to last saved state");
    }
  }, [originalValue, onChange]);

  const handleSaveClick = useCallback(() => {
    if (parseError) {
      toast.error("Cannot save: syntax error in JSON");
      return;
    }
    onSaveRef.current?.();
  }, [parseError]);

  // Keymap extension to handle Mod-s (Cmd+S / Ctrl+S)
  const keymapExtension = useMemo(() => {
    return keymap.of([
      {
        key: "Mod-s",
        run: () => {
          if (!readOnly && onSaveRef.current) {
            handleSaveClick();
            return true;
          }
          return false;
        },
      },
    ]);
  }, [readOnly, handleSaveClick]);

  const extensions = useMemo(() => {
    return [
      json(),
      lintGutter(),
      linter(jsonParseLinter()),
      keymapExtension,
    ];
  }, [keymapExtension]);

  const isDark = codeTheme?.mode === "dark" || codeTheme?.mode === undefined;
  const isDirty = originalValue !== undefined && value !== originalValue;

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-border bg-card overflow-hidden shadow-sm",
        className
      )}
    >
      {showToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-border/70 bg-muted/20 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {title && (
              <div className="flex items-center gap-1.5">
                <Icon name="Code" className="size-4 text-primary shrink-0" />
                <span className="font-mono text-xs font-semibold text-foreground truncate">
                  {title}
                </span>
                {isDirty && (
                  <span className="size-1.5 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                )}
              </div>
            )}
            {description && (
              <span className="hidden sm:inline text-[11px] text-muted-foreground truncate">
                • {description}
              </span>
            )}
            {parseError ? (
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-destructive/15 text-destructive border border-destructive/30 truncate max-w-[200px]"
                title={parseError}
              >
                Invalid JSON
              </span>
            ) : (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Valid JSON
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0 ml-auto">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleFormat}
              disabled={readOnly}
              className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
              title="Format JSON (Indent 2 spaces)"
            >
              Format
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
              title="Copy to clipboard"
            >
              <Icon name="Copy" className="size-3.5 mr-1" />
              Copy
            </Button>
            {originalValue !== undefined && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleReset}
                disabled={!isDirty || readOnly}
                className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                title="Revert changes"
              >
                Reset
              </Button>
            )}
            {onSave && !readOnly && (
              <Button
                type="button"
                size="sm"
                onClick={handleSaveClick}
                disabled={isSaving || parseError !== null || !isDirty}
                className="h-7 text-xs px-3"
                title="Save changes (Cmd+S / Ctrl+S)"
              >
                {isSaving ? (
                  <>
                    <Icon name="Loading" className="size-3.5 mr-1 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Icon name="Check" className="size-3.5 mr-1" />
                    Save
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 relative overflow-hidden bg-background">
        <CodeMirror
          ref={editorRef}
          value={value}
          onChange={onChange}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          theme={isDark ? "dark" : "light"}
          extensions={extensions}
          readOnly={readOnly}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLineGutter: true,
            highlightActiveLine: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            history: true,
          }}
          className="h-full font-mono text-xs [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono [&_.cm-scroller]:text-xs [&_.cm-gutters]:border-r [&_.cm-gutters]:border-border/40 [&_.cm-gutters]:bg-muted/10"
        />
      </div>

      {parseError && (
        <div className="px-3 py-1.5 border-t border-destructive/30 bg-destructive/10 text-destructive text-xs font-mono flex items-center gap-2 shrink-0 break-all">
          <Icon name="AlertCircle" className="size-3.5 shrink-0" />
          <span>{parseError}</span>
        </div>
      )}
    </div>
  );
}
