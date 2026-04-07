import { describe, expect, it, vi } from "vitest";
import { createMinimaxiAdapter } from "./adapter";

describe("minimaxi adapter", () => {
  it("generateImage parses image_urls and base_resp", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { image_urls: ["https://cdn.example.com/a.png"] },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const a = createMinimaxiAdapter();
    const r = await a.generateImage!(
      { modelId: "image-01", prompt: "a cat" },
      {
        fetch: fetchMock as typeof fetch,
        apiKey: "k",
        vendorId: "minimaxi",
      },
    );
    expect(r.images[0]?.url).toBe("https://cdn.example.com/a.png");
    expect(fetchMock).toHaveBeenCalled();
  });
});
