"use client";

import { useState } from "react";

export default function Home() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  async function handleAsk() {
  if (!question.trim() || !file) return;

  setLoading(true);

  try {
    const formData = new FormData();

    formData.append("question", question);
    formData.append("file", file);

    const response = await fetch("/api/ask", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Backend error:", data);
      setAnswer(data.error || "Something went wrong");
      return;
    }

    setAnswer(data.answer);
    setSources(data.sources);
  } catch (error) {
    console.error("Request error:", error);
    setAnswer(
      "Something went wrong while contacting the server."
    );
  } finally {
    setLoading(false);
  }
}

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold">
            PDF RAG Assistant
          </h1>

          <p className="mt-2 text-gray-500">
            Ask questions about your document
          </p>
        </div>

        <div className="rounded-xl border bg-pink-400 p-6 shadow-sm">

          {/* PDF Upload */}
          <label className="mb-4 block">
            <span className="mb-2 block font-medium">
              Upload PDF
            </span>

            <input
              type="file"
              accept=".pdf"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
              }}
              className="block w-full rounded-lg border bg-white p-2"
            />

            {file && (
              <p className="mt-2 text-sm">
                Selected: {file.name}
              </p>
            )}
          </label>

          {/* Question */}
          <label className="mb-2 block font-medium">
            Ask a question
          </label>

          <div className="flex gap-3">
            <input
              value={question}
              onChange={(e) =>
                setQuestion(e.target.value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleAsk();
                }
              }}
              placeholder="e.g. What are the library timings?"
              className="flex-1 rounded-lg border px-4 py-3 outline-none focus:ring-2"
            />

            <button
              onClick={handleAsk}
              className="rounded-lg bg-black px-5 py-3 text-white hover:opacity-80"
            >
              {loading ? "Searching..." : "Ask"}
            </button>
          </div>
        </div>

        {answer && (
          <div className="mt-6 rounded-xl border bg-pink-400 p-6 shadow-sm">
            <h2 className="mb-3 text-lg font-semibold">
              Answer
            </h2>

            <p className="leading-7 text-gray-700">
              {answer}
            </p>

            {sources.length > 0 && (
              <p>
                Sources: Pages {sources.join(", ")}
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}