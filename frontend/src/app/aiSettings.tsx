// Settings > AI API: pick a provider and region from the server's fixed list, add its key, pick a model
// and test it. Until a test passes, AI features keep using the server's default connection (if any).
import { useEffect, useId, useState, type FormEvent } from "react";
import { useAiSettings, useFetchModels, useRemoveAiKey, useSaveAiConnection, useTestModel, type AiSettings } from "./aiApi";
import { formatDateTime } from "./format";
import { PreviewUnavailable } from "./preview";
import { Alert, Badge, Field, PasswordField, QueryError, SelectField, SkeletonList, Spinner } from "./ui";

const SERVER = "server";

interface Notice {
  tone: "success" | "error" | "info";
  text: string;
}

function statusBadge(settings: AiSettings) {
  if (settings.active === "own") return <Badge tone="success">Your connection</Badge>;
  if (settings.active === "server") return <Badge tone="accent">Server default</Badge>;
  return <Badge tone="warning">Off</Badge>;
}

function AiConnectionForm({ settings }: { settings: AiSettings }) {
  const save = useSaveAiConnection();
  const fetchModels = useFetchModels();
  const test = useTestModel();
  const removeKey = useRemoveAiKey();
  const listId = useId();
  const [provider, setProvider] = useState(settings.provider ?? "");
  const [model, setModel] = useState(settings.model_id);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    setProvider(settings.provider ?? "");
    setModel(settings.model_id);
  }, [settings.provider, settings.model_id]);

  const own = provider !== "" && provider !== SERVER;
  const preset = settings.providers.find((choice) => choice.id === provider) ?? null;
  const savedProvider = settings.provider ?? "";
  const dirty = provider !== savedProvider || (own && model.trim() !== settings.model_id) || key.trim() !== "";
  const keyReady = !preset?.requires_key || key.trim() !== "" || (provider === savedProvider && settings.credential_loaded);
  const busy = save.isPending || fetchModels.isPending || test.isPending || removeKey.isPending;
  const readOnly = settings.read_only;

  const chooseProvider = (next: string) => {
    // A new provider starts clean: its key, model and model list are its own.
    setProvider(next);
    setModel(next === savedProvider ? settings.model_id : "");
    setKey("");
    setModels([]);
    setNotice(null);
  };

  /** Saves the draft when it differs from what the server has. Returns false when saving failed. */
  const saveDraft = async (): Promise<boolean> => {
    if (!dirty || !provider) return true;
    try {
      await save.mutateAsync({ provider, model_id: own ? model.trim() : "", api_key: own && key.trim() ? key.trim() : undefined });
      setKey("");
      return true;
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
      return false;
    }
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    if (await saveDraft()) {
      setNotice({
        tone: "success",
        text: own ? "Connection saved. Test the selected model to start using it." : "AI features use the server's default connection.",
      });
    }
  };

  const onFetch = async () => {
    setNotice(null);
    if (!(await saveDraft())) return;
    try {
      const result = await fetchModels.mutateAsync();
      setModels(result.models);
      if (!result.success) setNotice({ tone: "error", text: result.message ?? "Models could not be listed." });
      else if (result.models.length === 0) setNotice({ tone: "info", text: "No models returned. You can still type a model ID." });
      else setNotice({ tone: "info", text: `Found ${result.models.length} models. Select one, then test it.` });
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    }
  };

  const onTest = async () => {
    setNotice(null);
    if (!(await saveDraft())) return;
    try {
      const result = await test.mutateAsync(model.trim());
      setNotice(
        result.success
          ? { tone: "success", text: `Connection verified in ${result.latency_ms} ms. AI Chat is ready.` }
          : { tone: "error", text: result.message ?? "The model did not pass its test." },
      );
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    }
  };

  return (
    <form className="ai-settings-form" onSubmit={onSave}>
      <fieldset disabled={busy || readOnly}>
        <legend className="visually-hidden">AI connection</legend>
        <SelectField label="Provider / region" value={provider} onChange={(event) => chooseProvider(event.target.value)}>
          {settings.provider === null && !settings.server_default.available ? <option value="">Select provider</option> : null}
          {settings.server_default.available ? (
            <option value={SERVER}>Server default{settings.server_default.model ? ` (${settings.server_default.model})` : ""}</option>
          ) : null}
          {settings.providers.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </SelectField>
        {preset ? (
          <p className="ai-settings-base muted">
            Base URL (fixed): <code>{preset.base_url}</code>
          </p>
        ) : null}
        {own && preset?.requires_key ? (
          <PasswordField
            label="API key"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={provider === savedProvider && settings.credential_loaded ? "Key saved; leave blank to keep it" : "Paste this provider's API key"}
            hint="Stored encrypted on the server and never shown again. Switching providers removes the old key."
            onChange={(event) => setKey(event.target.value)}
          />
        ) : null}
        {own && preset && !preset.requires_key ? (
          <p className="field-hint">This runs on the server's own machine and needs no key; Ollama listens on port 11434.</p>
        ) : null}
        {own ? (
          <>
            <Field
              label="Model ID"
              value={model}
              list={listId}
              autoComplete="off"
              spellCheck={false}
              placeholder="For example deepseek-chat"
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id={listId}>
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </>
        ) : null}
        <div className="form-actions ai-settings-actions">
          <button type="submit" className="button primary" disabled={!dirty || !provider}>
            {save.isPending ? <Spinner size={16} /> : null}
            Save connection
          </button>
          {own ? (
            <>
              <button type="button" className="button secondary" onClick={onFetch} disabled={!keyReady}>
                {fetchModels.isPending ? <Spinner size={16} /> : null}
                Fetch models
              </button>
              <button type="button" className="button secondary" onClick={onTest} disabled={!keyReady || !model.trim()}>
                {test.isPending ? <Spinner size={16} /> : null}
                Test selected model
              </button>
            </>
          ) : null}
          {own && provider === savedProvider && settings.credential_loaded ? (
            <button type="button" className="button danger-ghost" onClick={() => removeKey.mutate()}>
              Remove key
            </button>
          ) : null}
        </div>
        {busy ? (
          <p className="muted" role="status">
            Connecting…
          </p>
        ) : null}
      </fieldset>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
    </form>
  );
}

export function AiSettingsSection() {
  const settings = useAiSettings();
  const data = settings.data;
  return (
    <section className="card settings-section" id="ai" aria-labelledby="ai-heading">
      <h2 id="ai-heading">AI API</h2>
      <p className="muted">
        AI Chat, assignment summaries and time estimates use this connection. Your own key is used only for your account.
      </p>
      {settings.isPending ? <SkeletonList rows={2} label="Loading AI settings" /> : null}
      {settings.isError ? <QueryError error={settings.error} retry={() => void settings.refetch()} /> : null}
      {data ? (
        <>
          {data.read_only ? <PreviewUnavailable>A preview uses the server's AI connection and can't change it.</PreviewUnavailable> : null}
          {data.needs_provider_selection ? (
            <Alert tone="warning">The provider you saved is no longer offered on this server. Choose another one.</Alert>
          ) : null}
          <dl className="detail-list">
            <div>
              <dt>In use</dt>
              <dd>
                {statusBadge(data)} {data.active_model ? <span className="muted">{data.active_model}</span> : null}
              </dd>
            </div>
            {data.verified_at ? (
              <div>
                <dt>Last tested</dt>
                <dd>{formatDateTime(data.verified_at)}</dd>
              </div>
            ) : null}
          </dl>
          <AiConnectionForm settings={data} />
          <p className="muted ai-settings-foot">
            {data.provider !== null && data.provider !== SERVER && !data.verified
              ? data.server_default.available
                ? "Until the selected model passes its test, AI features keep using the server default."
                : "AI Chat stays off until the selected model passes its connection test."
              : data.chat_ready
                ? "AI Chat is ready."
                : "AI Chat is off. Choose a provider, add its key and test a model."}
          </p>
        </>
      ) : null}
    </section>
  );
}
