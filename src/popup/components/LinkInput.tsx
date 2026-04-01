import { useState, useCallback } from 'preact/hooks';

interface LinkInputProps {
  onAnalyze: (url: string) => void;
  analyzing: boolean;
  error?: string;
}

const URL_PATTERN = /^https?:\/\/.+/i;

export function LinkInput({ onAnalyze, analyzing, error }: LinkInputProps) {
  const [url, setUrl] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (e: Event) => {
      e.preventDefault();
      const trimmed = url.trim();

      if (!trimmed) {
        setValidationError('Please enter a URL');
        return;
      }

      if (!URL_PATTERN.test(trimmed)) {
        setValidationError('Please enter a valid URL (starting with http:// or https://)');
        return;
      }

      setValidationError(null);
      onAnalyze(trimmed);
    },
    [url, onAnalyze]
  );

  const handleInput = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    setUrl(target.value);
    setValidationError(null);
  }, []);

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const pasted = e.clipboardData?.getData('text')?.trim();
      if (pasted && URL_PATTERN.test(pasted)) {
        // Auto-analyze on valid URL paste
        setTimeout(() => onAnalyze(pasted), 0);
      }
    },
    [onAnalyze]
  );

  const displayError = validationError || error;

  return (
    <form class="link-input-form" onSubmit={handleSubmit}>
      <div class="input-row">
        <input
          type="text"
          class={`url-input ${displayError ? 'input-error' : ''}`}
          placeholder="Paste video URL here..."
          value={url}
          onInput={handleInput}
          onPaste={handlePaste}
          disabled={analyzing}
          spellcheck={false}
          autocomplete="off"
        />
        <button
          type="submit"
          class="btn btn-primary analyze-btn"
          disabled={analyzing}
        >
          {analyzing ? (
            <>
              <span class="spinner" /> Analyzing...
            </>
          ) : (
            'Analyze'
          )}
        </button>
      </div>
      {displayError && <p class="error-message">{displayError}</p>}
    </form>
  );
}
