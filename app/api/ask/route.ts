export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { Document } from "@langchain/core/documents";
import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import {
  GoogleGenerativeAIEmbeddings,
  ChatGoogleGenerativeAI,
} from "@langchain/google-genai";

import { CloudClient } from "chromadb";

const CHROMA_COLLECTION_NAME = "ragpdf_document_chunks";

/* ---------------- CHROMA ---------------- */

function getChromaClient() {
  const apiKey = process.env.CHROMA_API_KEY;
  const tenant = process.env.CHROMA_TENANT;
  const database = process.env.CHROMA_DATABASE;

  if (!apiKey || !tenant || !database) {
    throw new Error(
      "Missing Chroma Cloud config. Set CHROMA_API_KEY, CHROMA_TENANT, and CHROMA_DATABASE."
    );
  }

  return new CloudClient({
    apiKey,
    tenant,
    database,
  });
}

/* ---------------- PDF ---------------- */

async function loadPdfPages(
  pdfBuffer: Buffer
): Promise<Document[]> {
  const parser = new PDFParse({
    data: new Uint8Array(pdfBuffer),
  });

  try {
    const { pages } = await parser.getText();

    return pages.map(
      (page) =>
        new Document({
          pageContent: page.text,
          metadata: {
            source: "uploaded-pdf",
            page: page.num - 1,
          },
        })
    );
  } finally {
    await parser.destroy();
  }
}

/* ---------------- CREATE / INITIALIZE CHROMA COLLECTION ---------------- */

async function initializeCollection(
  pdfBuffer: Buffer
) {
  const client = getChromaClient();

  const collection =
    await client.getOrCreateCollection({
      name: CHROMA_COLLECTION_NAME,

      // We generate embeddings ourselves using Gemini.
      // Chroma should NOT try to generate them.
      embeddingFunction: null,
    });

  const existingCount =
    await collection.count();

  console.log(
    "Existing chunks in Chroma:",
    existingCount
  );

  // If chunks already exist,
  // don't process and embed the PDF again.
  if (existingCount > 0) {
    console.log(
      "Using existing Chroma data"
    );

    return collection;
  }

  console.log(
    "No existing chunks. Indexing PDF..."
  );

  // 1. Load uploaded PDF
  const docs =
    await loadPdfPages(pdfBuffer);

  console.log(
    "Loaded pages:",
    docs.length
  );

  // 2. Split PDF into chunks
  const splitter =
    new RecursiveCharacterTextSplitter({
      chunkSize: 200,
      chunkOverlap: 20,
    });

  const chunks =
    await splitter.splitDocuments(docs);

  console.log(
    "Chunks created:",
    chunks.length
  );

  // 3. Create embedding model
  const embeddingModel =
    new GoogleGenerativeAIEmbeddings({
      model: "gemini-embedding-001",
    });

  // 4. Get text from every chunk
  const chunkTexts =
    chunks.map(
      (chunk) => chunk.pageContent
    );

  // 5. Convert chunks → embeddings
  const embeddings =
    await embeddingModel.embedDocuments(
      chunkTexts
    );

  console.log(
    "Embeddings created:",
    embeddings.length
  );

  console.log(
    "First embedding length:",
    embeddings[0]?.length
  );

  // 6. Save chunks + embeddings + metadata
  //    into Chroma Cloud
  await collection.add({
    ids: chunks.map(
      (_, index) => `chunk-${index}`
    ),

    documents: chunkTexts,

    embeddings: embeddings,

    metadatas: chunks.map(
      (chunk, index) => ({
        source:
          String(
            chunk.metadata.source ?? ""
          ),

        page:
          Number(
            chunk.metadata.page ?? 0
          ),

        chunkIndex: index,
      })
    ),
  });

  console.log(
    "Chunks successfully added to Chroma"
  );

  return collection;
}

/* ---------------- RERANKER ---------------- */

async function rerankChunks(
  question: string,
  matches: string[]
) {
  const response = await fetch(
    "https://api.cohere.com/v2/rerank",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        Authorization:
          `Bearer ${process.env.COHERE_API_KEY}`,
      },

      body: JSON.stringify({
        model: "rerank-v4.0-fast",

        query: question,

        documents: matches,

        top_n: 3,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Reranker error: ${await response.text()}`
    );
  }

  return response.json();
}

/* ---------------- POST ---------------- */

export async function POST(
  request: Request
) {
  try {
    // 1. Get question + uploaded PDF

    const formData =
      await request.formData();

    const question =
      formData.get("question");

    const file =
      formData.get("file");

    // Validate question

    if (
      !question ||
      typeof question !== "string" ||
      !question.trim()
    ) {
      return NextResponse.json(
        {
          error:
            "A question is required.",
        },
        {
          status: 400,
        }
      );
    }

    // Validate PDF

    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          error:
            "A PDF file is required.",
        },
        {
          status: 400,
        }
      );
    }

    // Convert uploaded file → Buffer

    const arrayBuffer =
      await file.arrayBuffer();

    const pdfBuffer =
      Buffer.from(arrayBuffer);

    console.log(
      "User asked:",
      question
    );

    console.log(
      "Uploaded file:",
      file.name
    );

    // 2. Get Chroma collection

    const collection =
      await initializeCollection(
        pdfBuffer
      );

    console.log(
      "Vector store ready"
    );

    // 3. Create Gemini embedding model

    const embeddingModel =
      new GoogleGenerativeAIEmbeddings({
        model: "gemini-embedding-001",
      });

    // 4. Convert user's question
    //    into an embedding

    const queryEmbedding =
      await embeddingModel.embedQuery(
        question
      );

    // 5. Search Chroma

    const results =
      await collection.query({
        queryEmbeddings: [
          queryEmbedding,
        ],

        nResults: 10,

        include: [
          "documents",
          "metadatas",
          "distances",
        ],
      });

    console.log(
      "Relevant chunks found:",
      results.documents?.[0]?.length ?? 0
    );

    // 6. Get retrieved documents

    const matches =
      (results.documents?.[0] ??
        []) as string[];

    const metadatas =
      (results.metadatas?.[0] ??
        []) as Array<{
          page?: number;
          source?: string;
          chunkIndex?: number;
        }>;

    // 7. Rerank retrieved chunks

    const reranked =
      await rerankChunks(
        question,
        matches
      );

    console.log(
      "Reranked results:",
      reranked.results
    );

    // 8. Get top 3 chunks

    const topChunks =
      reranked.results.map(
        (result: {
          index: number;
        }) =>
          matches[result.index]
      );

    // 9. Get metadata for top 3 chunks

    const topMetadatas =
      reranked.results.map(
        (result: {
          index: number;
        }) =>
          metadatas[result.index]
      ) as Array<{
        page?: number;
        source?: string;
        chunkIndex?: number;
      }>;

    // 10. Create context

    const context =
      topChunks.join("\n\n");

    // 11. Get source pages

    const sourcePages = [
      ...new Set(
        topMetadatas
          .map(
            (metadata) =>
              Number(
                metadata?.page ?? 0
              ) + 1
          )
          .filter(
            (page) =>
              Number.isFinite(page) &&
              page > 0
          )
      ),
    ];

    // 12. Create Gemini model

    const model =
      new ChatGoogleGenerativeAI({
        model: "gemini-3.6-flash",
      });

    // 13. Prompt Gemini

    const prompt = `
Answer the question using ONLY the context provided below.

If the answer is not in the context, say:
"I couldn't find that information in the document."

Context:
${context}

Question:
${question}
`;

    // 14. Ask Gemini

    const response =
      await model.invoke(prompt);

    console.log(
      "Gemini answered successfully"
    );

    // 15. Convert Gemini response to string

    const answerText =
      typeof response.content ===
      "string"
        ? response.content
        : Array.isArray(
            response.content
          )
        ? response.content
            .map((part) =>
              typeof part === "string"
                ? part
                : "text" in part
                ? part.text ?? ""
                : ""
            )
            .join("")
        : String(
            response.content ?? ""
          );

    // 16. Send answer to frontend

    return NextResponse.json({
      answer: answerText,
      sources: sourcePages,
    });

  } catch (error) {
    console.error(
      "RAG ERROR:",
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return NextResponse.json(
      {
        error: message,
      },
      {
        status: 500,
      }
    );
  }
}