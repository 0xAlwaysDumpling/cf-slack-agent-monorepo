import { describe, it, expect } from "vitest";
import { formatCompactSummary } from "../../src/messages/compact";

describe("formatCompactSummary", () => {
  it("should strip <analysis> block and extract <summary> content", () => {
    const raw = `<analysis>
Some reasoning about the messages...
Walking through chronologically...
</analysis>

<summary>
1. **Discussion Overview**: The team discussed deployment.
2. **Key Decisions**: Use Cloudflare Workers.
</summary>`;

    const result = formatCompactSummary(raw);

    expect(result).not.toContain("<analysis>");
    expect(result).not.toContain("</analysis>");
    expect(result).not.toContain("<summary>");
    expect(result).not.toContain("</summary>");
    expect(result).toContain("Discussion Overview");
    expect(result).toContain("Key Decisions");
  });

  it("should handle summary without analysis block", () => {
    const raw = `<summary>
1. **Discussion Overview**: Quick chat about API design.
</summary>`;

    const result = formatCompactSummary(raw);

    expect(result).toContain("Discussion Overview");
    expect(result).not.toContain("<summary>");
  });

  it("should handle raw text without any XML tags", () => {
    const raw = "Just a plain summary with no tags.";
    const result = formatCompactSummary(raw);
    expect(result).toBe("Just a plain summary with no tags.");
  });

  it("should collapse excessive newlines", () => {
    const raw = `<analysis>
stuff
</analysis>



<summary>
content here



more content
</summary>`;

    const result = formatCompactSummary(raw);
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("should trim whitespace", () => {
    const raw = `  <summary>  
  some content  
  </summary>  `;

    const result = formatCompactSummary(raw);
    expect(result).toBe("some content");
  });
});
