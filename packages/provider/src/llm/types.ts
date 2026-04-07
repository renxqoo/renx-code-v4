export type MessageRole = "system" | "user" | "assistant";

export type TextPart = { type: "text"; text: string };

export type CanonicalMessage = {
  role: MessageRole;
  content: TextPart[];
};

export type CanonicalGenerateParams = {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
};

export type CanonicalFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "error"
  | "other";

export type CanonicalUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type CanonicalRequest = {
  modelId: string;
  messages: CanonicalMessage[];
  params: CanonicalGenerateParams;
  providerOptions?: Record<string, unknown>;
};

export type CanonicalTextResult = {
  text: string;
  finishReason: CanonicalFinishReason;
  usage?: CanonicalUsage;
  raw?: unknown;
};

export type TextDeltaChunk = { type: "text-delta"; textDelta: string };

export type FinishChunk = {
  type: "finish";
  finishReason: CanonicalFinishReason;
  usage?: CanonicalUsage;
};

export type CanonicalStreamChunk = TextDeltaChunk | FinishChunk;

export type ModelHandle = {
  vendorId: string;
  modelId: string;
  providerOptions?: Record<string, unknown>;
};

export type AdapterCapabilities = {
  streaming: boolean;
  maxOutputTokens?: { min: number; max: number };
  supportsTopP: boolean;
  supportsStopSequences: boolean;
  notes?: string;
};

// --- Image generation ---

export type CanonicalImageRequest = {
  modelId: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  responseFormat?: "url" | "b64_json";
  providerOptions?: Record<string, unknown>;
};

export type CanonicalImageItem = {
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;
};

export type CanonicalImageResult = {
  images: CanonicalImageItem[];
  raw?: unknown;
};

// --- Text-to-speech ---

export type CanonicalSpeechRequest = {
  modelId: string;
  text: string;
  voice?: string;
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  speed?: number;
  providerOptions?: Record<string, unknown>;
};

export type CanonicalSpeechResult = {
  audio: Uint8Array;
  contentType?: string;
  raw?: unknown;
};

// --- Speech-to-text (transcription) ---

export type CanonicalTranscriptionRequest = {
  modelId: string;
  audio: Uint8Array;
  filename?: string;
  language?: string;
  prompt?: string;
  responseFormat?: "json" | "text" | "verbose_json" | "vtt" | "srt";
  providerOptions?: Record<string, unknown>;
};

export type CanonicalTranscriptionSegment = {
  start: number;
  end: number;
  text: string;
};

export type CanonicalTranscriptionResult = {
  text: string;
  segments?: CanonicalTranscriptionSegment[];
  language?: string;
  durationSeconds?: number;
  raw?: unknown;
};

// --- Video generation (async jobs on most providers) ---

export type CanonicalVideoJobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "other";

export type CanonicalVideoRequest = {
  modelId: string;
  prompt: string;
  size?: string;
  seconds?: number;
  providerOptions?: Record<string, unknown>;
};

export type CanonicalVideoResult = {
  videoId: string;
  status: CanonicalVideoJobStatus;
  progress?: number;
  raw?: unknown;
};

export type CanonicalVideoJobQuery = {
  videoId: string;
};

/** Query for downloading rendered video bytes (OpenAI: `videoId`; MiniMax: `fileId` from job query). */
export type CanonicalVideoDownloadQuery = {
  videoId?: string;
  fileId?: string;
};

export type CanonicalVideoJob = {
  videoId: string;
  status: CanonicalVideoJobStatus;
  progress?: number;
  error?: string;
  /** MiniMax: `file_id` after task status is Success; required for `downloadVideo`. */
  fileId?: string;
  raw?: unknown;
};

export type CanonicalVideoContentResult = {
  data: Uint8Array;
  contentType?: string;
};
