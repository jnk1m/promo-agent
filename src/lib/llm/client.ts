// 모델 호출의 얇은 이음새. 공급자와 모델 이름은 설정(환경변수)으로 받는다.
// OpenAI 에서는 시험하지 않았다(키 없음). 교체 가능하다고 주장하지 않는다.
import { generateText, Output, type LanguageModel } from 'ai';

type ProviderOptions = Parameters<typeof generateText>[0]['providerOptions'];
import type { ZodType } from 'zod';

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmObjectRequest<T> {
  system: string;
  prompt: string;
  schema: ZodType<T>;
  maxOutputTokens: number;
  timeoutMs: number;
  purpose: 'explain' | 'interpret';
}

export interface LlmClient {
  readonly id: string;
  generateObject<T>(req: LlmObjectRequest<T>): Promise<T>;
}

export class LlmError extends Error {
  constructor(
    readonly code: 'timeout' | 'schema' | 'provider',
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function resolveProvider(): { provider: LlmProvider; modelId: string } {
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider;
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error(`LLM_PROVIDER must be anthropic or openai, got ${provider}`);
  const modelId = process.env.LLM_MODEL ?? (provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5');
  return { provider, modelId };
}

export async function createEnvClient(): Promise<LlmClient> {
  const { provider, modelId } = resolveProvider();
  let model: LanguageModel;
  let providerOptions: ProviderOptions;
  if (provider === 'anthropic') {
    const { anthropic } = await import('@ai-sdk/anthropic');
    model = anthropic(modelId);
    providerOptions = { anthropic: { effort: 'low' } };
  } else {
    const { openai } = await import('@ai-sdk/openai');
    model = openai(modelId);
  }
  return createAiSdkClient(model, `${provider}:${modelId}`, providerOptions);
}

export function createAiSdkClient(model: LanguageModel, id: string, providerOptions?: ProviderOptions): LlmClient {
  return {
    id,
    async generateObject<T>(req: LlmObjectRequest<T>): Promise<T> {
      try {
        const result = await generateText({
          model,
          system: req.system,
          prompt: req.prompt,
          output: Output.object({ schema: req.schema }),
          maxOutputTokens: req.maxOutputTokens,
          providerOptions,
          abortSignal: AbortSignal.timeout(req.timeoutMs),
          maxRetries: 0,
        });
        return result.output as T;
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        const msg = err instanceof Error ? err.message : String(err);
        const ctx = `${req.purpose} (model=${id}, maxOutputTokens=${req.maxOutputTokens}, timeoutMs=${req.timeoutMs})`;
        if (name === 'TimeoutError' || name === 'AbortError') throw new LlmError('timeout', `모델 호출 시간 초과: ${ctx}`);
        if (name.startsWith('AI_NoObjectGenerated') || name.startsWith('AI_TypeValidation') || name.startsWith('AI_JSONParse')) throw new LlmError('schema', `모델 출력이 스키마와 다름: ${ctx}: ${msg.slice(0, 200)}`);
        throw new LlmError('provider', `모델 호출 실패: ${ctx}: ${name} ${msg.slice(0, 200)}`);
      }
    },
  };
}

// 테스트용: 정해진 답을 순서대로 돌려준다(HTTP 없음)
export function scriptedClient(responses: unknown[]): LlmClient & { calls: LlmObjectRequest<unknown>[] } {
  const calls: LlmObjectRequest<unknown>[] = [];
  let i = 0;
  return {
    id: 'scripted',
    calls,
    async generateObject<T>(req: LlmObjectRequest<T>): Promise<T> {
      calls.push(req as LlmObjectRequest<unknown>);
      if (i >= responses.length) throw new LlmError('provider', 'scripted client: no more responses');
      const r = responses[i++];
      const parsed = req.schema.safeParse(r);
      if (!parsed.success) throw new LlmError('schema', `scripted response failed schema: ${parsed.error.message.slice(0, 200)}`);
      return parsed.data;
    },
  };
}
