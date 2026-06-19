export function plan(question: string): string {
  return [
    "You are a research planner. Given the following research question, generate 1-6 diverse search queries that approach the topic from different angles.",
    "Each query should target a different aspect or perspective to maximize coverage.",
    "",
    `Research question: "${question}"`,
    "",
    "Return an object with a 'queries' array. Each entry has 'query' (the search string) and 'angle' (brief description of what this explores).",
  ].join("\n")
}

export function extract(input: { question: string; source: { url: string; content: string } }): string {
  return [
    "You are a fact extractor. Given a source document and a research question, extract falsifiable factual claims relevant to the question.",
    "Each fact must be a specific, verifiable claim (not opinion or speculation).",
    "Include source URLs and rate confidence (high/medium/low) based on source authority and specificity.",
    "",
    `Research question: "${input.question}"`,
    `Source URL: ${input.source.url}`,
    "",
    "Source content:",
    input.source.content.slice(0, 15000),
    "",
    "Return an object with a 'facts' array. Each entry has 'claim' (string), 'source_urls' (array with this URL), and 'confidence' (high/medium/low).",
  ].join("\n")
}

export function group(input: { question: string; facts: Array<{ claim: string; source_urls: string[] }> }): string {
  return [
    "You are a fact organizer. Given a list of extracted facts, group them by topic, merge duplicates, and deduplicate overlapping claims.",
    "Preserve source attribution. Cap output to the most important facts.",
    "",
    `Research question: "${input.question}"`,
    "",
    "Facts to organize:",
    JSON.stringify(input.facts, null, 2),
    "",
    "Return an object with a 'groups' array. Each group has 'topic' (string) and 'facts' array (each with claim, source_urls, confidence).",
  ].join("\n")
}

export function crosscheck(input: { claim: string; sources: string[] }): string {
  return [
    "You are a fact-checker juror. Evaluate whether the following claim is supported by available evidence.",
    "Vote: 'support' if evidence confirms it, 'reject' if evidence contradicts it, 'abstain' if insufficient evidence.",
    "Provide brief reasoning for your verdict.",
    "",
    `Claim: "${input.claim}"`,
    "",
    "Source context:",
    input.sources.join("\n---\n").slice(0, 10000),
    "",
    "Return an object with 'verdict' (support/reject/abstain) and 'reasoning' (brief explanation).",
  ].join("\n")
}

export function report(input: {
  question: string
  facts: Array<{ claim: string; confidence: string; source_urls: string[] }>
}): string {
  return [
    "You are a research report writer. Synthesize the verified facts into a well-structured report with citations.",
    "Include a title, summary, sections with headings, and a sources list. Rate overall certainty.",
    "",
    `Research question: "${input.question}"`,
    "",
    "Verified facts:",
    JSON.stringify(input.facts, null, 2),
    "",
    "Return an object with: title, summary, sections (array of {heading, body, citations: number[]}), sources (array of {index, url, title}), and certainty (high/medium/low/inconclusive).",
  ].join("\n")
}
