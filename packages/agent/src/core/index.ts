import { streamText, type CanonicalStreamChunk } from '@renx/provider';
import type { Message } from './message';


export type QueryModelType = {
  model: string;
  systemPrompt: string;
  messages: Message[];
}

export class Agent {
  protected config: {
    maxSteps: number;
  };
  constructor(config: {
    maxSteps: number;
  }) {
    this.config = config;
  }


  handleChunk(chunk: CanonicalStreamChunk) {
    console.log(chunk)
  }

  async queryModel(config: QueryModelType) {

    while (true) {
      const { textStream } = await streamText(config);
      for await (const chunk of textStream) {
         this.handleChunk(chunk)
      }
    }
  }
}
