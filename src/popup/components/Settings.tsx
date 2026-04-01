import { useState, useEffect } from 'preact/hooks';
import type { ExtensionSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';

const QUALITY_OPTIONS: Array<{ value: ExtensionSettings['preferredQuality']; label: string }> = [
  { value: 'best', label: 'Best Available' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
  { value: '360p', label: '360p' },
];

const ALL_PROVIDERS = [
  'vimeo',
  'streamable',
  'wistia',
  'jwplayer',
  'brightcove',
  'dailymotion',
  'cloudflare-stream',
  'html5-direct',
  'hls-generic',
  'dash-generic',
];

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response: ExtensionSettings | undefined) => {
      if (chrome.runtime.lastError) return;
      if (response) {
        setSettings(response);
      }
      setLoading(false);
    });
  }, []);

  const update = <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const toggleProvider = (provider: string) => {
    setSettings((prev) => {
      const enabled = prev.enabledProviders.includes(provider)
        ? prev.enabledProviders.filter((p) => p !== provider)
        : [...prev.enabledProviders, provider];
      return { ...prev, enabledProviders: enabled };
    });
    setDirty(true);
  };

  const handleSave = () => {
    setSaving(true);
    chrome.runtime.sendMessage(
      { type: 'UPDATE_SETTINGS', settings },
      () => {
        setSaving(false);
        setDirty(false);
        onClose();
      },
    );
  };

  const handleClearHistory = () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }, () => {
      // History cleared
    });
  };

  if (loading) {
    return (
      <div class="settings-panel">
        <div class="settings-header">
          <h2 class="settings-title">Settings</h2>
          <button class="btn-icon" onClick={onClose} aria-label="Close settings">✕</button>
        </div>
        <div class="empty-state">
          <div class="loading-spinner" />
          <p>Loading settings…</p>
        </div>
      </div>
    );
  }

  return (
    <div class="settings-panel">
      <div class="settings-header">
        <h2 class="settings-title">Settings</h2>
        <button class="btn-icon" onClick={onClose} aria-label="Close settings">✕</button>
      </div>

      <div class="settings-body">
        {/* Preferred Quality */}
        <div class="settings-group">
          <label class="settings-label" htmlFor="pref-quality">Preferred Quality</label>
          <select
            id="pref-quality"
            class="quality-dropdown"
            value={settings.preferredQuality}
            onChange={(e) =>
              update('preferredQuality', (e.target as HTMLSelectElement).value as ExtensionSettings['preferredQuality'])
            }
          >
            {QUALITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Toggles */}
        <div class="settings-group">
          <label class="toggle-row">
            <span>Auto-detect videos</span>
            <input
              type="checkbox"
              checked={settings.autoDetect}
              onChange={(e) => update('autoDetect', (e.target as HTMLInputElement).checked)}
            />
          </label>
          <label class="toggle-row">
            <span>Download subtitles</span>
            <input
              type="checkbox"
              checked={settings.downloadSubtitles}
              onChange={(e) => update('downloadSubtitles', (e.target as HTMLInputElement).checked)}
            />
          </label>
          <label class="toggle-row">
            <span>Show notifications</span>
            <input
              type="checkbox"
              checked={settings.showNotifications}
              onChange={(e) => update('showNotifications', (e.target as HTMLInputElement).checked)}
            />
          </label>
        </div>

        {/* Provider List */}
        <div class="settings-group">
          <span class="settings-label">Providers</span>
          <div class="provider-list">
            {ALL_PROVIDERS.map((p) => (
              <label class="checkbox-label" key={p}>
                <input
                  type="checkbox"
                  checked={settings.enabledProviders.includes(p)}
                  onChange={() => toggleProvider(p)}
                />
                <span>{p}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Clear History */}
        <div class="settings-group">
          <button class="btn btn-secondary btn-block" onClick={handleClearHistory}>
            🗑 Clear Download History
          </button>
        </div>
      </div>

      {/* Save / Cancel */}
      <div class="settings-footer">
        <button class="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? <><span class="spinner" /> Saving…</> : 'Save'}
        </button>
      </div>
    </div>
  );
}
