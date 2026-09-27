import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import {
  PI_CONFIG_CHANGED,
  type McpConfig,
  type McpServer,
  type PiModelOption,
  type PiSettings,
  type TestResult,
} from "./lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { JsonCodeEditor } from "./components/JsonCodeEditor";
import { cn } from "@/lib/utils";

interface ServerFormState {
  name: string;
  type: "http" | "sse" | "stdio";
  url: string;
  command: string;
  args: string;
  authHeader: string;
  lifecycle: "lazy" | "eager";
  directTools: boolean;
}

const DEFAULT_FORM: ServerFormState = {
  name: "",
  type: "http",
  url: "",
  command: "",
  args: "",
  authHeader: "",
  lifecycle: "lazy",
  directTools: false,
};

function formToServer(form: ServerFormState): McpServer {
  const server: McpServer = {
    type: form.type,
    lifecycle: form.lifecycle,
    directTools: form.directTools ? true : undefined,
  };

  if (form.type === "stdio") {
    server.command = form.command.trim();
    if (form.args.trim()) {
      server.args = form.args.trim().split(/\s+/).filter(Boolean);
    }
  } else {
    server.url = form.url.trim();
    if (form.authHeader.trim()) {
      const headerVal = form.authHeader.trim();
      server.headers = {
        Authorization: headerVal.startsWith("Bearer ") || headerVal.startsWith("${")
          ? headerVal
          : `Bearer ${headerVal}`,
      };
    }
  }
  return server;
}

function serverToForm(name: string, s: McpServer): ServerFormState {
  const type = (s.type as "http" | "sse" | "stdio") || (s.url ? "http" : "stdio");
  const authHeader = s.headers?.Authorization || s.headers?.authorization || "";
  const command = Array.isArray(s.command) ? s.command[0] || "" : s.command || "";
  const args = Array.isArray(s.command) && s.command.length > 1
    ? s.command.slice(1).join(" ")
    : (s.args || []).join(" ");

  return {
    name,
    type,
    url: s.url || "",
    command,
    args,
    authHeader,
    lifecycle: s.lifecycle || "lazy",
    directTools: !!s.directTools,
  };
}

function modelSelectionValue(provider: string | undefined, model: string | undefined): string {
  if (!model) return "";
  return provider ? `${provider}/${model}` : model;
}

function splitModelSelection(selection: string): { provider?: string; model: string } {
  const separator = selection.indexOf("/");
  if (separator <= 0) return { model: selection };
  return {
    provider: selection.slice(0, separator),
    model: selection.slice(separator + 1),
  };
}

export function PiManagerPage() {
  const rpc = useRpc<typeof rpcContract>();

  // Top Tabs: "mcp" vs "settings"
  const [activeTab, setActiveTab] = useState<"mcp" | "settings">("mcp");

  // MCP Sub-tabs: "servers" vs "raw"
  const [mcpSubTab, setMcpSubTab] = useState<"servers" | "raw">("servers");

  // Settings Sub-tabs: "visual" vs "raw"
  const [settingsSubTab, setSettingsSubTab] = useState<"visual" | "raw">("visual");

  // Core Data
  const [status, setStatus] = useState<any>(null);
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [modelOptions, setModelOptions] = useState<PiModelOption[]>([]);
  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // Search in MCP servers list
  const [searchQuery, setSearchQuery] = useState("");

  // Raw Editors
  const [rawMcpJson, setRawMcpJson] = useState("");
  const [originalMcpJson, setOriginalMcpJson] = useState("");
  const [savingMcpJson, setSavingMcpJson] = useState(false);

  const [rawSettingsJson, setRawSettingsJson] = useState("");
  const [originalSettingsJson, setOriginalSettingsJson] = useState("");
  const [savingSettingsJson, setSavingSettingsJson] = useState(false);

  // Visual Settings Form State
  const [visualModel, setVisualModel] = useState("");
  const [savingVisualSettings, setSavingVisualSettings] = useState(false);
  const [newPackageInput, setNewPackageInput] = useState("");
  const [addingPackage, setAddingPackage] = useState(false);

  // Testing Latency States
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  // Add Server Dialog
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<"form" | "json">("form");
  const [addForm, setAddForm] = useState<ServerFormState>(DEFAULT_FORM);
  const [addRawJson, setAddRawJson] = useState("");
  const [testBeforeAdd, setTestBeforeAdd] = useState(true);
  const [submittingAdd, setSubmittingAdd] = useState(false);

  // Edit Server Dialog
  const [editingServerName, setEditingServerName] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<"form" | "json">("form");
  const [editForm, setEditForm] = useState<ServerFormState>(DEFAULT_FORM);
  const [editRawJson, setEditRawJson] = useState("");
  const [submittingEdit, setSubmittingEdit] = useState(false);

  // Delete Server Confirmation Dialog
  const [serverToDelete, setServerToDelete] = useState<string | null>(null);
  const [deletingServer, setDeletingServer] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, sett, modelCatalog, mcp] = await Promise.all([
        rpc.call("pi_get_status", null),
        rpc.call("pi_get_settings", null),
        rpc.call("pi_get_models", null),
        rpc.call("pi_get_mcp_config", null),
      ]);

      setStatus(s);
      setSettings(sett);
      const formattedSettings = JSON.stringify(sett, null, 2);
      setRawSettingsJson(formattedSettings);
      setOriginalSettingsJson(formattedSettings);

      setVisualModel(modelSelectionValue(sett.defaultProvider, sett.defaultModel));
      setModelOptions(modelCatalog.models);

      setMcpConfig(mcp);
      const formattedMcp = JSON.stringify(mcp, null, 2);
      setRawMcpJson(formattedMcp);
      setOriginalMcpJson(formattedMcp);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load Pi configuration");
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtime(PI_CONFIG_CHANGED, refresh);

  // Copy helper with toast
  const copyToClipboard = async (text: string, label: string) => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        toast.success(`Copied ${label} to clipboard`);
      }
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  // --- Save Raw MCP.json ---
  const handleSaveMcpJson = async () => {
    try {
      JSON.parse(rawMcpJson);
    } catch (err: any) {
      toast.error(`Invalid JSON: ${err.message}`);
      return;
    }

    setSavingMcpJson(true);
    try {
      await rpc.call("pi_save_mcp_raw", { raw: rawMcpJson });
      toast.success("mcp.json saved successfully");
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || "Failed to save mcp.json");
    } finally {
      setSavingMcpJson(false);
    }
  };

  // --- Save Raw Settings.json ---
  const handleSaveSettingsJson = async () => {
    try {
      JSON.parse(rawSettingsJson);
    } catch (err: any) {
      toast.error(`Invalid JSON: ${err.message}`);
      return;
    }

    setSavingSettingsJson(true);
    try {
      await rpc.call("pi_save_settings_raw", { raw: rawSettingsJson });
      toast.success("settings.json saved successfully");
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || "Failed to save settings.json");
    } finally {
      setSavingSettingsJson(false);
    }
  };

  // --- Save Visual Settings Form ---
  const handleSaveVisualSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSavingVisualSettings(true);
    try {
      const selected = splitModelSelection(visualModel.trim());
      await rpc.call("pi_update_settings", {
        defaultModel: selected.model || undefined,
        defaultProvider: selected.provider || undefined,
      });
      toast.success("Settings updated");
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || "Failed to update settings");
    } finally {
      setSavingVisualSettings(false);
    }
  };

  // --- Add Package ---
  const handleAddPackage = async (e: FormEvent) => {
    e.preventDefault();
    const pkg = newPackageInput.trim();
    if (!pkg) return;
    setAddingPackage(true);
    try {
      await rpc.call("pi_package_add", { pkg });
      toast.success(`Package "${pkg}" added`);
      setNewPackageInput("");
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || `Failed to add package "${pkg}"`);
    } finally {
      setAddingPackage(false);
    }
  };

  // --- Remove Package ---
  const handleRemovePackage = async (pkg: string) => {
    try {
      await rpc.call("pi_package_remove", { pkg });
      toast.success(`Package "${pkg}" removed`);
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || `Failed to remove package "${pkg}"`);
    }
  };

  // --- Toggle MCP Server ---
  const handleToggleMcp = async (name: string, currentlyDisabled: boolean) => {
    try {
      await rpc.call("pi_mcp_toggle", { name, disabled: !currentlyDisabled });
      toast.success(`Server "${name}" ${currentlyDisabled ? "enabled" : "disabled"}`);
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || `Failed to toggle server "${name}"`);
    }
  };

  // --- Test / Ping MCP Server ---
  const handleTestMcp = async (name: string) => {
    setTesting((prev) => ({ ...prev, [name]: true }));
    const toastId = toast.loading(`Pinging "${name}"…`);
    try {
      const res = await rpc.call("pi_mcp_test", { name });
      setTestResults((prev) => ({ ...prev, [name]: res }));
      if (res.ok) {
        toast.success(`"${name}" is reachable (${res.latencyMs}ms)`, { id: toastId });
      } else {
        toast.error(`"${name}" ping failed: ${res.message}`, { id: toastId });
      }
    } catch (err: any) {
      toast.error(`Failed to ping "${name}": ${err.message}`, { id: toastId });
    } finally {
      setTesting((prev) => ({ ...prev, [name]: false }));
    }
  };

  // --- Delete MCP Server ---
  const confirmDeleteServer = async () => {
    if (!serverToDelete) return;
    setDeletingServer(true);
    try {
      await rpc.call("pi_mcp_remove", { name: serverToDelete });
      toast.success(`Removed MCP server "${serverToDelete}"`);
      setServerToDelete(null);
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || `Failed to remove server "${serverToDelete}"`);
    } finally {
      setDeletingServer(false);
    }
  };

  // --- Open Add Modal ---
  const openAddModal = () => {
    setAddForm(DEFAULT_FORM);
    setAddRawJson(
      JSON.stringify(
        {
          url: "https://...",
          type: "http",
          lifecycle: "lazy",
          headers: {
            Authorization: "${TOKEN}",
          },
        },
        null,
        2
      )
    );
    setAddMode("form");
    setShowAddModal(true);
  };

  // --- Open Edit Modal ---
  const openEditModal = (name: string, s: McpServer) => {
    const form = serverToForm(name, s);
    setEditingServerName(name);
    setEditForm(form);
    setEditRawJson(JSON.stringify(s, null, 2));
    setEditMode("form");
  };

  // --- Submit Add Server ---
  const handleAddServer = async (e: FormEvent) => {
    e.preventDefault();
    setSubmittingAdd(true);

    try {
      let finalName: string;
      let finalJson: string;

      if (addMode === "form") {
        finalName = addForm.name.trim();
        if (!finalName) {
          toast.error("Please enter a server identifier");
          setSubmittingAdd(false);
          return;
        }
        const serverObj = formToServer(addForm);
        finalJson = JSON.stringify(serverObj, null, 2);
      } else {
        finalName = addForm.name.trim();
        if (!finalName) {
          toast.error("Please enter a server identifier");
          setSubmittingAdd(false);
          return;
        }
        try {
          JSON.parse(addRawJson);
          finalJson = addRawJson;
        } catch (err: any) {
          toast.error(`Invalid JSON definition: ${err.message}`);
          setSubmittingAdd(false);
          return;
        }
      }

      const res = await rpc.call("pi_mcp_verify_and_add", {
        name: finalName,
        json: finalJson,
        testFirst: testBeforeAdd,
      });

      if (!res.ok) {
        toast.error(res.error || "Failed to add server");
        setSubmittingAdd(false);
        return;
      }

      toast.success(`MCP server "${finalName}" added successfully`);
      setShowAddModal(false);
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || "Failed to add server");
    } finally {
      setSubmittingAdd(false);
    }
  };

  // --- Submit Edit Server ---
  const handleEditServer = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingServerName) return;
    setSubmittingEdit(true);

    try {
      let finalName: string;
      let finalJson: string;

      if (editMode === "form") {
        finalName = editForm.name.trim() || editingServerName;
        const serverObj = formToServer(editForm);
        finalJson = JSON.stringify(serverObj, null, 2);
      } else {
        finalName = editForm.name.trim() || editingServerName;
        try {
          JSON.parse(editRawJson);
          finalJson = editRawJson;
        } catch (err: any) {
          toast.error(`Invalid JSON definition: ${err.message}`);
          setSubmittingEdit(false);
          return;
        }
      }

      const res = await rpc.call("pi_mcp_save_json", {
        originalName: editingServerName,
        ...(finalName !== editingServerName ? { newName: finalName } : {}),
        json: finalJson,
      });

      if (!res.ok) {
        toast.error(res.error || "Failed to save server");
        setSubmittingEdit(false);
        return;
      }

      toast.success(`MCP server "${finalName}" updated`);
      setEditingServerName(null);
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || "Failed to update server");
    } finally {
      setSubmittingEdit(false);
    }
  };

  // Filtered MCP servers
  const servers = mcpConfig?.mcpServers || {};
  const serverEntries = useMemo(() => Object.entries(servers), [servers]);

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return serverEntries;
    const q = searchQuery.toLowerCase();
    return serverEntries.filter(([name, s]) => {
      const targetStr = s.url || (Array.isArray(s.command) ? s.command.join(" ") : s.command) || "";
      return (
        name.toLowerCase().includes(q) ||
        (s.type && s.type.toLowerCase().includes(q)) ||
        targetStr.toLowerCase().includes(q)
      );
    });
  }, [serverEntries, searchQuery]);

  const enabledCount = serverEntries.filter(([_, s]) => !s.disabled).length;
  const disabledCount = serverEntries.length - enabledCount;

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-background text-foreground">
      {/* Consolidated Top Navigation Bar */}
      <div className="border-b border-border/80 bg-card/40 px-3 py-2 sm:px-4 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Left: Tab Switcher + Sub-view Mode */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Main Tabs */}
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab("mcp")}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] font-medium transition-all text-xs",
                  activeTab === "mcp"
                    ? "bg-background text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon name="Toolbox" className="size-3.5" />
                <span>MCP Servers</span>
                <span
                  className={cn(
                    "ml-0.5 text-[10px] font-mono px-1.5 py-0.2 rounded-full",
                    activeTab === "mcp"
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {serverEntries.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("settings")}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] font-medium transition-all text-xs",
                  activeTab === "settings"
                    ? "bg-background text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon name="Settings" className="size-3.5" />
                <span>Settings</span>
              </button>
            </div>

            {/* Divider */}
            <div className="h-4 w-px bg-border/60 mx-0.5" />

            {/* Sub-view switcher */}
            {activeTab === "mcp" ? (
              <div className="inline-flex rounded-md border border-border p-0.5 bg-muted/30 text-xs">
                <button
                  type="button"
                  onClick={() => setMcpSubTab("servers")}
                  className={cn(
                    "px-2 py-0.5 rounded-[4px] font-medium transition-colors text-xs flex items-center gap-1",
                    mcpSubTab === "servers"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon name="ListTodo" className="size-3" />
                  List
                </button>
                <button
                  type="button"
                  onClick={() => setMcpSubTab("raw")}
                  className={cn(
                    "px-2 py-0.5 rounded-[4px] font-medium transition-colors text-xs font-mono flex items-center gap-1",
                    mcpSubTab === "raw"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon name="Code" className="size-3" />
                  mcp.json
                </button>
              </div>
            ) : (
              <div className="inline-flex rounded-md border border-border p-0.5 bg-muted/30 text-xs">
                <button
                  type="button"
                  onClick={() => setSettingsSubTab("visual")}
                  className={cn(
                    "px-2 py-0.5 rounded-[4px] font-medium transition-colors text-xs flex items-center gap-1",
                    settingsSubTab === "visual"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon name="SlidersHorizontal" className="size-3" />
                  Visual
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsSubTab("raw")}
                  className={cn(
                    "px-2 py-0.5 rounded-[4px] font-medium transition-colors text-xs font-mono flex items-center gap-1",
                    settingsSubTab === "raw"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon name="Code" className="size-3" />
                  settings.json
                </button>
              </div>
            )}

            {activeTab === "mcp" && mcpSubTab === "servers" && serverEntries.length > 0 && (
              <div className="hidden md:flex items-center gap-2 text-[11px] text-muted-foreground pl-1">
                <span className="flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-emerald-400" />
                  {enabledCount} active
                </span>
                {disabledCount > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                    {disabledCount} disabled
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right: Search + Add Server (or Machine Pill) */}
          <div className="flex items-center gap-2 ml-auto">
            {activeTab === "mcp" && mcpSubTab === "servers" && (
              <>
                <div className="relative w-36 sm:w-52">
                  <Icon
                    name="Search"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none"
                  />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter servers…"
                    className="h-7 pl-7 pr-6 text-xs bg-background/80"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                    >
                      <Icon name="X" className="size-3" />
                    </button>
                  )}
                </div>

                <Button
                  size="sm"
                  className="h-7 text-xs px-2.5 shrink-0"
                  onClick={openAddModal}
                >
                  <Icon name="Plus" className="size-3.5 mr-1" />
                  Add Server
                </Button>
              </>
            )}

            {status?.machine && (
              <span className="hidden lg:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted/40 rounded border border-border/50">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                {status.machine}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Content Pane */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* ================= TAB 1: MCP SERVERS ================= */}
        {activeTab === "mcp" && (
          <div className="h-full min-h-0 flex flex-col overflow-hidden">
            {/* MCP Sub-View: Servers List */}
            {mcpSubTab === "servers" && (
              <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
                <div className="mx-auto max-w-5xl space-y-3">
                  {serverEntries.length === 0 ? (
                    <div className="p-10 border border-dashed border-border rounded-xl text-center space-y-3 bg-muted/5">
                      <div className="size-10 rounded-full bg-muted flex items-center justify-center mx-auto text-muted-foreground">
                        <Icon name="Toolbox" className="size-5" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">No MCP servers configured</h3>
                        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                          MCP servers give your Pi agent access to external tools, databases, and APIs.
                        </p>
                      </div>
                      <Button size="sm" onClick={openAddModal} className="h-8 text-xs">
                        <Icon name="Plus" className="size-3.5 mr-1" />
                        Add First Server
                      </Button>
                    </div>
                  ) : filteredEntries.length === 0 ? (
                    <div className="p-8 border border-dashed border-border rounded-lg text-center space-y-2 bg-muted/5">
                      <p className="text-xs sm:text-sm text-muted-foreground">
                        No servers found matching "{searchQuery}"
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSearchQuery("")}
                        className="h-7 text-xs"
                      >
                        Clear Search
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {filteredEntries.map(([name, s]) => {
                        const isDisabled = s.disabled === true;
                        const testRes = testResults[name];
                        const isTesting = testing[name];
                        const typeLabel = s.type || (s.url ? "http" : "stdio");
                        const lcLabel = s.lifecycle || "lazy";
                        const targetStr =
                          s.url ||
                          (Array.isArray(s.command) ? s.command.join(" ") : s.command) ||
                          "";

                        return (
                          <div
                            key={name}
                            className={cn(
                              "group relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg border border-border bg-card transition-all duration-200 shadow-xs hover:border-border/90 hover:shadow-sm",
                              isDisabled && "opacity-65 bg-muted/20 border-border/50"
                            )}
                          >
                            {/* Left: Switch + Server Info */}
                            <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                              {/* Custom Switch */}
                              <button
                                type="button"
                                role="switch"
                                aria-checked={!isDisabled}
                                onClick={() => handleToggleMcp(name, isDisabled)}
                                className={cn(
                                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out mt-0.5 sm:mt-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                                  !isDisabled ? "bg-emerald-500" : "bg-muted-foreground/30"
                                )}
                                title={isDisabled ? "Enable server" : "Disable server"}
                              >
                                <span
                                  className={cn(
                                    "pointer-events-none inline-block size-4 transform rounded-full bg-white shadow-xs transition duration-200 ease-in-out",
                                    !isDisabled ? "translate-x-4" : "translate-x-0"
                                  )}
                                />
                              </button>

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span
                                    className={cn(
                                      "font-semibold text-sm tracking-tight text-foreground",
                                      isDisabled && "line-through text-muted-foreground"
                                    )}
                                  >
                                    {name}
                                  </span>

                                  {/* Transport Badge */}
                                  <span
                                    className={cn(
                                      "text-[10px] font-mono uppercase px-1.5 py-0.2 rounded font-medium border",
                                      typeLabel === "stdio"
                                        ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                        : "bg-sky-500/10 text-sky-400 border-sky-500/20"
                                    )}
                                  >
                                    {typeLabel}
                                  </span>

                                  {/* Lifecycle Badge */}
                                  {lcLabel !== "lazy" && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                      {lcLabel}
                                    </span>
                                  )}

                                  {/* Direct Tools Badge */}
                                  {s.directTools && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                      direct-tools
                                    </span>
                                  )}
                                </div>

                                {/* Endpoint / Command string with copy */}
                                <div className="flex items-center gap-1.5 mt-1 min-w-0">
                                  <span
                                    className="text-xs font-mono text-muted-foreground truncate max-w-[280px] sm:max-w-md select-all"
                                    title={targetStr}
                                  >
                                    {targetStr}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(targetStr, `endpoint for "${name}"`)}
                                    className="p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors shrink-0"
                                    title="Copy URL / command"
                                  >
                                    <Icon name="Copy" className="size-3" />
                                  </button>

                                  {s.headers && Object.keys(s.headers).length > 0 && (
                                    <span
                                      className="text-[10px] font-mono text-muted-foreground/70 px-1.5 py-0.2 rounded bg-muted/60 border border-border/40"
                                      title={`Headers: ${Object.keys(s.headers).join(", ")}`}
                                    >
                                      {Object.keys(s.headers).length} header
                                      {Object.keys(s.headers).length > 1 ? "s" : ""}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Right: Latency & Actions */}
                            <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-border/40">
                              {testRes && (
                                <div
                                  className={cn(
                                    "text-[11px] font-mono px-2 py-0.5 rounded border flex items-center gap-1.5 shrink-0 max-w-[180px] truncate",
                                    testRes.ok
                                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                                      : "bg-destructive/10 border-destructive/30 text-destructive"
                                  )}
                                  title={testRes.message}
                                >
                                  <span
                                    className={cn(
                                      "size-1.5 rounded-full shrink-0",
                                      testRes.ok ? "bg-emerald-400" : "bg-destructive"
                                    )}
                                  />
                                  <span className="truncate">
                                    {testRes.ok ? `${testRes.latencyMs}ms` : testRes.message}
                                  </span>
                                </div>
                              )}

                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  disabled={isTesting || isDisabled}
                                  onClick={() => handleTestMcp(name)}
                                  className="size-8 text-muted-foreground hover:text-foreground"
                                  title="Test connection"
                                >
                                  <Icon
                                    name={isTesting ? "Loading" : "Zap"}
                                    className={cn("size-3.5", isTesting && "animate-spin text-primary")}
                                  />
                                </Button>

                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openEditModal(name, s)}
                                  className="size-8 text-muted-foreground hover:text-foreground"
                                  title="Edit configuration"
                                >
                                  <Icon name="Edit" className="size-3.5" />
                                </Button>

                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setServerToDelete(name)}
                                  className="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                  title="Remove server"
                                >
                                  <Icon name="Trash2" className="size-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* MCP Sub-View: Raw mcp.json Code Editor */}
            {mcpSubTab === "raw" && (
              <div className="flex-1 min-h-0 flex flex-col p-3 sm:p-4">
                <JsonCodeEditor
                  value={rawMcpJson}
                  onChange={setRawMcpJson}
                  onSave={handleSaveMcpJson}
                  originalValue={originalMcpJson}
                  title="mcp.json"
                  description="Hot-reloads on save and invalidates Pi MCP cache"
                  isSaving={savingMcpJson}
                  className="flex-1 min-h-0"
                />
              </div>
            )}
          </div>
        )}

        {/* ================= TAB 2: SETTINGS ================= */}
        {activeTab === "settings" && (
          <div className="h-full min-h-0 flex flex-col overflow-hidden">
            {/* Settings Sub-View: Visual Config */}
            {settingsSubTab === "visual" && (
              <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
                <div className="mx-auto max-w-3xl space-y-6">
                  {/* Card 1: Model Default */}
                  <Card className="border-border">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Icon name="Bot" className="size-4 text-primary" />
                        Model Default
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Choose the default model Pi uses when a new session starts. Thinking options come from the selected model.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <form onSubmit={handleSaveVisualSettings} className="space-y-4">
                        <div>
                          <label className="text-xs font-medium text-muted-foreground block mb-1.5">
                            Default Model
                          </label>
                          <select
                            value={visualModel}
                            onChange={(e) => setVisualModel(e.target.value)}
                            disabled={modelOptions.length === 0 && !visualModel}
                            className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs font-mono outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {!visualModel && <option value="">No models available</option>}
                            {visualModel && !modelOptions.some((option) => option.id === visualModel) && (
                              <option value={visualModel}>{visualModel}</option>
                            )}
                            {modelOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.displayName} ({option.id})
                              </option>
                            ))}
                          </select>
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            {modelOptions.length > 0
                              ? "Provider and model are stored together. Pi derives available thinking levels from this model."
                              : "No provider models were discovered on this host yet."}
                          </p>
                        </div>

                        <div className="flex justify-end pt-2">
                          <Button
                            type="submit"
                            size="sm"
                            disabled={savingVisualSettings}
                            className="h-8 text-xs px-4"
                          >
                            {savingVisualSettings ? (
                              <>
                                <Icon name="Loading" className="size-3.5 mr-1 animate-spin" />
                                Saving…
                              </>
                            ) : (
                              <>
                                <Icon name="Check" className="size-3.5 mr-1" />
                                Save Model Settings
                              </>
                            )}
                          </Button>
                        </div>
                      </form>
                    </CardContent>
                  </Card>

                  {/* Card 2: Packages & Extensions */}
                  <Card className="border-border">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Icon name="ToolCase" className="size-4 text-primary" />
                        Installed Packages & Extensions
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Packages configured in Pi's runtime environment.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Add package input */}
                      <form onSubmit={handleAddPackage} className="flex gap-2">
                        <Input
                          value={newPackageInput}
                          onChange={(e) => setNewPackageInput(e.target.value)}
                          placeholder="npm package name or path (e.g. @pi/memory)"
                          className="h-8 font-mono text-xs flex-1"
                        />
                        <Button
                          type="submit"
                          size="sm"
                          disabled={addingPackage || !newPackageInput.trim()}
                          className="h-8 text-xs shrink-0"
                        >
                          {addingPackage ? (
                            <Icon name="Loading" className="size-3.5 animate-spin" />
                          ) : (
                            <>
                              <Icon name="Plus" className="size-3.5 mr-1" />
                              Add Package
                            </>
                          )}
                        </Button>
                      </form>

                      {/* Package list */}
                      {(!settings?.packages || settings.packages.length === 0) ? (
                        <div className="p-4 rounded-md border border-dashed border-border text-center text-xs text-muted-foreground">
                          No extra packages installed.
                        </div>
                      ) : (
                        <div className="divide-y divide-border/60 rounded-md border border-border bg-background overflow-hidden">
                          {settings.packages.map((pkg) => (
                            <div
                              key={pkg}
                              className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                            >
                              <span className="font-mono text-foreground">{pkg}</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemovePackage(pkg)}
                                className="h-6 px-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                title="Remove package"
                              >
                                <Icon name="Trash2" className="size-3" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}

            {/* Settings Sub-View: Raw settings.json Code Editor */}
            {settingsSubTab === "raw" && (
              <div className="flex-1 min-h-0 flex flex-col p-3 sm:p-4">
                <JsonCodeEditor
                  value={rawSettingsJson}
                  onChange={setRawSettingsJson}
                  onSave={handleSaveSettingsJson}
                  originalValue={originalSettingsJson}
                  title="settings.json"
                  description="Auto-backed up with .bak and validated on save"
                  isSaving={savingSettingsJson}
                  className="flex-1 min-h-0"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================= ADD MCP MODAL ================= */}
      <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
        <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden border-border bg-card">
          <DialogHeader className="p-4 pb-3 border-b border-border/70">
            <div className="flex items-center justify-between gap-2">
              <div>
                <DialogTitle className="text-base font-semibold">Add MCP Server</DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Configure an MCP server with connection testing and auto-reload.
                </DialogDescription>
              </div>

              {/* Form vs JSON Mode Toggle */}
              <div className="inline-flex rounded-md border border-border p-0.5 bg-muted/40 text-xs shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    if (addMode === "json") {
                      try {
                        const parsed = JSON.parse(addRawJson);
                        setAddForm((prev) => ({
                          ...prev,
                          ...serverToForm(prev.name || "new-server", parsed),
                        }));
                      } catch {
                        // Keep current form
                      }
                    }
                    setAddMode("form");
                  }}
                  className={cn(
                    "px-2 py-0.5 rounded-[4px] font-medium transition-colors text-xs",
                    addMode === "form"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Form
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (addMode === "form") {
                      const serverObj = formToServer(addForm);
                      setAddRawJson(JSON.stringify(serverObj, null, 2));
                    }
                    setAddMode("json");
                  }}
                  className={cn(
                    "px-2 py-0.5 rounded-[4px] font-medium transition-colors text-xs font-mono",
                    addMode === "json"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  JSON
                </button>
              </div>
            </div>
          </DialogHeader>

          <form onSubmit={handleAddServer} className="p-4 space-y-3.5">
            {/* Server Name */}
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Server Identifier
              </label>
              <Input
                value={addForm.name}
                onChange={(e) => setAddForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. github, fetch, postgres"
                required
                className="font-mono text-xs h-8"
              />
            </div>

            {addMode === "form" ? (
              <>
                {/* Transport Type */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">
                    Transport Type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(["http", "sse", "stdio"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setAddForm((prev) => ({ ...prev, type: t }))}
                        className={cn(
                          "py-1.5 px-3 rounded-md border text-xs font-medium uppercase font-mono transition-all",
                          addForm.type === t
                            ? "border-primary bg-primary/10 text-primary font-semibold"
                            : "border-border bg-background text-muted-foreground hover:bg-muted/30"
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                {/* HTTP / SSE URL */}
                {addForm.type !== "stdio" ? (
                  <>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Endpoint URL
                      </label>
                      <Input
                        value={addForm.url}
                        onChange={(e) => setAddForm((prev) => ({ ...prev, url: e.target.value }))}
                        placeholder="https://..."
                        required
                        className="font-mono text-xs h-8"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Auth Token / Bearer Key (Optional)
                      </label>
                      <Input
                        value={addForm.authHeader}
                        onChange={(e) =>
                          setAddForm((prev) => ({ ...prev, authHeader: e.target.value }))
                        }
                        placeholder="Bearer token or ${ENV_KEY}"
                        className="font-mono text-xs h-8"
                      />
                    </div>
                  </>
                ) : (
                  /* Stdio Command & Args */
                  <>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Command
                      </label>
                      <Input
                        value={addForm.command}
                        onChange={(e) =>
                          setAddForm((prev) => ({ ...prev, command: e.target.value }))
                        }
                        placeholder="e.g. npx, uvx, node"
                        required
                        className="font-mono text-xs h-8"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Arguments (Space separated)
                      </label>
                      <Input
                        value={addForm.args}
                        onChange={(e) =>
                          setAddForm((prev) => ({ ...prev, args: e.target.value }))
                        }
                        placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
                        className="font-mono text-xs h-8"
                      />
                    </div>
                  </>
                )}

                {/* Lifecycle & Options */}
                <div className="pt-1 flex flex-wrap items-center justify-between gap-3 border-t border-border/50">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addForm.lifecycle === "eager"}
                      onChange={(e) =>
                        setAddForm((prev) => ({
                          ...prev,
                          lifecycle: e.target.checked ? "eager" : "lazy",
                        }))
                      }
                      className="rounded border-border text-primary"
                    />
                    <span>Eager connect on launch</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addForm.directTools}
                      onChange={(e) =>
                        setAddForm((prev) => ({
                          ...prev,
                          directTools: e.target.checked,
                        }))
                      }
                      className="rounded border-border text-primary"
                    />
                    <span>Direct tools mode</span>
                  </label>
                </div>
              </>
            ) : (
              /* Raw JSON Mode */
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">
                  Server Definition (JSON)
                </label>
                <JsonCodeEditor
                  value={addRawJson}
                  onChange={setAddRawJson}
                  height="180px"
                  showToolbar={false}
                  className="rounded-md border border-input"
                />
              </div>
            )}

            {addForm.type !== "stdio" && (
              <div className="pt-1">
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={testBeforeAdd}
                    onChange={(e) => setTestBeforeAdd(e.target.checked)}
                    className="rounded border-border text-primary"
                  />
                  <span>Verify connection before adding</span>
                </label>
              </div>
            )}

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowAddModal(false)}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={submittingAdd} className="h-8 text-xs">
                {submittingAdd ? (
                  <>
                    <Icon name="Loading" className="size-3.5 mr-1 animate-spin" />
                    Adding…
                  </>
                ) : (
                  "Add Server"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ================= EDIT MCP MODAL ================= */}
      <Dialog
        open={!!editingServerName}
        onOpenChange={(open) => !open && setEditingServerName(null)}
      >
        <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden border-border bg-card">
          <DialogHeader className="p-4 pb-3 border-b border-border/70">
            <div className="flex items-center justify-between gap-2">
              <div>
                <DialogTitle className="text-base font-semibold">
                  Edit MCP Server: {editingServerName}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Update endpoint, credentials, or launch lifecycle.
                </DialogDescription>
              </div>

              {/* Form vs JSON Mode Toggle */}
              <div className="inline-flex rounded-md border border-border p-0.5 bg-muted/40 text-xs shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    if (editMode === "json") {
                      try {
                        const parsed = JSON.parse(editRawJson);
                        setEditForm((prev) => ({
                          ...prev,
                          ...serverToForm(prev.name || editingServerName || "", parsed),
                        }));
                      } catch {
                        // Keep current
                      }
                    }
                    setEditMode("form");
                  }}
                  className={cn(
                    "px-2 py-0.5 rounded-[4px] font-medium transition-colors text-xs",
                    editMode === "form"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Form
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (editMode === "form") {
                      const serverObj = formToServer(editForm);
                      setEditRawJson(JSON.stringify(serverObj, null, 2));
                    }
                    setEditMode("json");
                  }}
                  className={cn(
                    "px-2 py-0.5 rounded-[4px] font-medium transition-colors text-xs font-mono",
                    editMode === "json"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  JSON
                </button>
              </div>
            </div>
          </DialogHeader>

          <form onSubmit={handleEditServer} className="p-4 space-y-3.5">
            {/* Server Name */}
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Server Identifier
              </label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                required
                className="font-mono text-xs h-8"
              />
            </div>

            {editMode === "form" ? (
              <>
                {/* Transport Type */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">
                    Transport Type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(["http", "sse", "stdio"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setEditForm((prev) => ({ ...prev, type: t }))}
                        className={cn(
                          "py-1.5 px-3 rounded-md border text-xs font-medium uppercase font-mono transition-all",
                          editForm.type === t
                            ? "border-primary bg-primary/10 text-primary font-semibold"
                            : "border-border bg-background text-muted-foreground hover:bg-muted/30"
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                {/* HTTP / SSE URL */}
                {editForm.type !== "stdio" ? (
                  <>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Endpoint URL
                      </label>
                      <Input
                        value={editForm.url}
                        onChange={(e) =>
                          setEditForm((prev) => ({ ...prev, url: e.target.value }))
                        }
                        placeholder="https://..."
                        required
                        className="font-mono text-xs h-8"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Auth Token / Bearer Key (Optional)
                      </label>
                      <Input
                        value={editForm.authHeader}
                        onChange={(e) =>
                          setEditForm((prev) => ({ ...prev, authHeader: e.target.value }))
                        }
                        placeholder="Bearer token or ${ENV_KEY}"
                        className="font-mono text-xs h-8"
                      />
                    </div>
                  </>
                ) : (
                  /* Stdio Command & Args */
                  <>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Command
                      </label>
                      <Input
                        value={editForm.command}
                        onChange={(e) =>
                          setEditForm((prev) => ({ ...prev, command: e.target.value }))
                        }
                        required
                        className="font-mono text-xs h-8"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Arguments (Space separated)
                      </label>
                      <Input
                        value={editForm.args}
                        onChange={(e) =>
                          setEditForm((prev) => ({ ...prev, args: e.target.value }))
                        }
                        className="font-mono text-xs h-8"
                      />
                    </div>
                  </>
                )}

                {/* Lifecycle & Options */}
                <div className="pt-1 flex flex-wrap items-center justify-between gap-3 border-t border-border/50">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.lifecycle === "eager"}
                      onChange={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          lifecycle: e.target.checked ? "eager" : "lazy",
                        }))
                      }
                      className="rounded border-border text-primary"
                    />
                    <span>Eager connect on launch</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.directTools}
                      onChange={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          directTools: e.target.checked,
                        }))
                      }
                      className="rounded border-border text-primary"
                    />
                    <span>Direct tools mode</span>
                  </label>
                </div>
              </>
            ) : (
              /* Raw JSON Mode */
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">
                  Server Definition (JSON)
                </label>
                <JsonCodeEditor
                  value={editRawJson}
                  onChange={setEditRawJson}
                  height="180px"
                  showToolbar={false}
                  className="rounded-md border border-input"
                />
              </div>
            )}

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditingServerName(null)}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={submittingEdit} className="h-8 text-xs">
                {submittingEdit ? (
                  <>
                    <Icon name="Loading" className="size-3.5 mr-1 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ================= DELETE CONFIRMATION MODAL ================= */}
      <Dialog
        open={!!serverToDelete}
        onOpenChange={(open) => !open && setServerToDelete(null)}
      >
        <DialogContent className="max-w-md p-5 border-border bg-card">
          <div className="flex items-start gap-3.5">
            <div className="flex items-center justify-center size-9 rounded-full bg-destructive/15 text-destructive shrink-0">
              <Icon name="Trash2" className="size-4.5" />
            </div>
            <div className="space-y-1">
              <DialogTitle className="text-base font-semibold text-foreground">
                Remove MCP Server
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
                Are you sure you want to remove{" "}
                <span className="font-semibold text-foreground font-mono">
                  "{serverToDelete}"
                </span>
                ? This will remove its configuration and environment variables from{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">mcp.json</code>.
              </DialogDescription>
            </div>
          </div>

          <DialogFooter className="mt-4 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setServerToDelete(null)}
              disabled={deletingServer}
              className="h-8 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={confirmDeleteServer}
              disabled={deletingServer}
              className="h-8 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingServer ? (
                <>
                  <Icon name="Loading" className="size-3.5 mr-1 animate-spin" />
                  Removing…
                </>
              ) : (
                "Remove Server"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "pi-manager",
    title: "Pi Manager",
    icon: "Pi",
    path: "pi-manager",
    component: PiManagerPage,
  });
});
