import { GoogleGenAI, GenerateContentResponse, Modality } from "@google/genai";

const API_KEY = process.env.GEMINI_API_KEY || "AIzaSyC0N4N_JtW5FqHAfjXj5vqSy-Vzt5nmABw";

export const ai = new GoogleGenAI({ apiKey: API_KEY });

export interface MessagePart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface ChatMessage {
  role: "user" | "model";
  parts: MessagePart[];
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
}

export async function* sendMessageStream(
  history: ChatMessage[],
  message: string,
  image?: { mimeType: string; data: string }
) {
  const model = "gemini-3.1-pro-preview";
  
  const parts: any[] = [{ text: message }];
  if (image) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.data,
      },
    });
  }

  const chat = ai.chats.create({
    model,
    config: {
      systemInstruction: "You are Bihar AI, a chat and voice model expert. You can analyze images and explain their content in detail. You have deep knowledge about Bihar and India. You provide clear, accurate, and insightful responses in Hindi, English, and local dialects of Bihar. You are professional, fast, and unique. If the user greets you, introduce yourself as Bihar AI.",
      tools: [{ googleSearch: {} }],
    },
    history: history.slice(0, -1), // Exclude the current message which is sent via sendMessageStream
  });

  const result = await chat.sendMessageStream({
    message: parts,
  });

  for await (const chunk of result) {
    yield (chunk as GenerateContentResponse).text || "";
  }
}

export async function generateSpeech(text: string) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    },
  });

  return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
}

export async function generateImage(prompt: string) {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: prompt || "A beautiful image",
  });
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return part.inlineData.data;
    }
  }
  return null;
}

export async function generateVideo(prompt: string, image1?: { mimeType: string, data: string }, image2?: { mimeType: string, data: string }) {
  const currentApiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || "AIzaSyC0N4N_JtW5FqHAfjXj5vqSy-Vzt5nmABw";
  const videoAi = new GoogleGenAI({ apiKey: currentApiKey });

  let operation = await videoAi.models.generateVideos({
    model: 'veo-3.1-fast-generate-preview',
    prompt: prompt || "A beautiful scene",
    image: image1 ? { imageBytes: image1.data, mimeType: image1.mimeType } : undefined,
    config: {
      numberOfVideos: 1,
      resolution: '720p',
      lastFrame: image2 ? { imageBytes: image2.data, mimeType: image2.mimeType } : undefined,
      aspectRatio: '16:9'
    }
  });

  while (!operation.done) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    operation = await videoAi.operations.getVideosOperation({ operation });
  }

  const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
  if (!downloadLink) throw new Error("Video generation failed");

  const response = await fetch(downloadLink, {
    method: 'GET',
    headers: {
      'x-goog-api-key': currentApiKey,
    },
  });
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
