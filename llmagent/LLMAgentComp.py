import datetime
import json
from google import genai
from typing import Optional

class LLMAgent:
    # Use 2.5-Flash for speed/cost, or 3.0-Pro for complex reasoning
    MODEL = "gemini-2.5-flash"

    def __init__(self, api_key: str, memory):
        # Initialize the new Client
        self.client = genai.Client(api_key=api_key)
        self.memory = memory
        
        # Define the persona once
        self.system_instruction = (
            "You are a senior equity analyst specializing in fundamental analysis. "
            "Your tone is professional, objective, and data-driven. Use precise "
            "financial terminology. Avoid generic openers and flowery language."
        )

    # ─────────────────────────────────────────────────────────
    # INTERNAL HELPERS
    # ─────────────────────────────────────────────────────────

    def _get_context(self, symbol: str) -> dict:
        metrics = self.memory.retrieve(f"{symbol}_METRICS")
        score = self.memory.retrieve(f"{symbol}_SCORE")
        if not metrics or not score:
            raise ValueError(f"Missing data for {symbol}. Ensure analysis agents have run.")
        return {"metrics": metrics, "score": score}

    def _fmt_context(self, symbol: str, ctx: dict) -> str:
        m, s = ctx["metrics"], ctx["score"]
        def pct(v): return f"{v*100:.1f}%" if v is not None else "N/A"
        def x(v):   return f"{v:.2f}x" if v is not None else "N/A"
        def usd(v):
            if v is None: return "N/A"
            if abs(v) >= 1e9: return f"${v/1e9:.2f}B"
            if abs(v) >= 1e6: return f"${v/1e6:.1f}M"
            return f"${v:,.0f}"

        return f"""
COMPANY: {symbol} | FY: {m.get('fiscal_year', 'N/A')}
OVERALL: {s.get('overall_score')}/100 [{s.get('grade')}] {s.get('descriptor')}
PROFITABILITY: ROE {pct(m.get('roe'))}, Margin {pct(m.get('profit_margin'))}
GROWTH: Revenue {pct(m.get('revenue_growth'))}, FCF {pct(m.get('fcf_growth'))}
SAFETY: Current {x(m.get('current_ratio'))}, D/E {x(m.get('debt_to_equity'))}, FCF {usd(m.get('free_cash_flow'))}
FLAGS: {', '.join(s.get('flags', [])) or 'None'}
""".strip()

    def _call(self, prompt, is_json: bool = False) -> str:
        """Helper updated for the new google-genai Client syntax, with retries and model rotation.
        Supports both text prompts (str) and multimodal content (list with text and file parts)."""
        import time
        max_retries = 15
        models = ["gemini-2.5-flash"]
        
        for attempt in range(max_retries):
            current_model = models[attempt % len(models)]
            try:
                # Handle both string and multimodal list inputs
                contents = prompt if isinstance(prompt, list) else prompt
                
                response = self.client.models.generate_content(
                    model=current_model,
                    contents=contents,
                    config={
                        "system_instruction": self.system_instruction,
                        "response_mime_type": "application/json" if is_json else "text/plain"
                    }
                )
                
                # Extract text from response
                result_text = response.text.strip() if hasattr(response, 'text') else str(response).strip()
                return result_text
                
            except Exception as e:
                err_str = str(e)
                if attempt == max_retries - 1:
                    if "429" in err_str or "quota" in err_str.lower():
                        raise Exception("API Rate Limit Reached for your Free Tier Key! Please wait approximately 1 minute before running another AI Analysis.")
                    # Provide more specific error for document analysis failures
                    if "document" in err_str.lower() or "multimod" in err_str.lower():
                        raise Exception(f"Document analysis failed: {err_str}")
                    raise e
                
                if "429" in err_str or "quota" in err_str.lower():
                    # Hit quota for this model. Stall specifically to let 60-second timeouts expire.
                    time.sleep(8)
                elif "503" in err_str:
                    # High demand on current model. Longer sleep before retrying.
                    time.sleep(3 + (2 ** attempt))
                else:
                    raise e

    # ─────────────────────────────────────────────────────────
    # PUBLIC METHODS
    # ─────────────────────────────────────────────────────────

    def verdict(self, symbol: str) -> str:
        cached = self.memory.retrieve(f"{symbol}_VERDICT")
        if cached: return cached
        
        ctx = self._get_context(symbol)
        context = self._fmt_context(symbol, ctx)
        prompt = f"Analyze the following data and write a concise, 4-6 sentence verdict.\n\n{context}"
        
        result = self._call(prompt)
        self.memory.store(f"{symbol}_VERDICT", result, ttl=3600)
        return result

    def compare(self, symbol_a: str, symbol_b: str) -> str:
        ctx_a, ctx_b = self._get_context(symbol_a), self._get_context(symbol_b)
        prompt = f"""
Compare {symbol_a} and {symbol_b} in 5-7 sentences. Identify the winner in profitability 
and safety, then state a clear preference.

--- {symbol_a} ---
{self._fmt_context(symbol_a, ctx_a)}

--- {symbol_b} ---
{self._fmt_context(symbol_b, ctx_b)}
"""
        result = self._call(prompt)
        self.memory.store(f"{symbol_a}_vs_{symbol_b}_COMPARE", result, ttl=3600)
        return result

    def recommend(self, symbol: str) -> dict:
        cached = self.memory.retrieve(f"{symbol}_RECOMMEND")
        if cached: return cached
        
        ctx = self._get_context(symbol)
        context = self._fmt_context(symbol, ctx)
        prompt = f"""
Provide a recommendation for {symbol} in JSON format:
{{
  "action": "BUY" | "HOLD" | "AVOID",
  "conviction": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "string",
  "risks": "string",
  "one_liner": "string"
}}

DATA:
{context}
"""
        raw_json = self._call(prompt, is_json=True)
        try:
            result = json.loads(raw_json)
        except json.JSONDecodeError:
            result = {"action": "ERROR", "reasoning": "Failed to parse JSON."}
        
        self.memory.store(f"{symbol}_RECOMMEND", result, ttl=3600)
        return result

    def chat(self, symbol: str, question: str) -> str:
        ctx = self._get_context(symbol)
        context = self._fmt_context(symbol, ctx)
        prompt = f"Using ONLY this data: {context}\n\nQuestion: {question}"
        
        result = self._call(prompt)
        ts = datetime.datetime.now(datetime.UTC).strftime('%H%M%S')
        self.memory.store(f"{symbol}_CHAT_{ts}", result, ttl=1800)
        return result

    def analyze_document(self, file_bytes: bytes, mime_type: str) -> dict:
        from google.genai import types
        prompt_text = """
Analyze this document. Extract the following information and return it strictly in valid JSON format:
{
  "category": "Invoice" | "Resume" | "Balance Sheet" | "Income Statement" | "Cash Flow" | "Other Financial Report" | "General Document",
  "summary": "A concise 3-4 sentence paragraph summarizing the document's purpose and key details.",
  "extracted_data": {  
    "key_entities": ["Entity 1", "Entity 2"],
    "important_dates": ["Date 1", "Date 2"],
    "monetary_amounts": ["Amount 1", "Amount 2"]
  }
}
If a field has no relevant data, return an empty list or null. Do not include markdown formatting or backticks outside the JSON.
"""
        try:
            multimodal_contents = [
                prompt_text,
                types.Part.from_bytes(data=file_bytes, mime_type=mime_type)
            ]
            
            raw_json = self._call(multimodal_contents, is_json=True)
            
            # Try to parse the JSON response
            try:
                return json.loads(raw_json)
            except json.JSONDecodeError as je:
                print(f"JSON Parse Error: {je}")
                print(f"Raw response: {raw_json[:200]}")
                # Return a valid response structure instead of failing
                return {
                    "category": "Unknown", 
                    "summary": "Document was processed but parsing failed. Please try again.", 
                    "extracted_data": {"key_entities": [], "important_dates": [], "monetary_amounts": []}
                }
        except Exception as e:
            print(f"Document analysis error: {e}")
            import traceback
            traceback.print_exc()
            # Provide a user-friendly error message
            error_msg = str(e)
            if "API Rate Limit" in error_msg:
                raise e  # Re-raise rate limit errors as-is
            raise Exception(f"Failed to analyze document: {error_msg}")

    def global_chat(self, history: list[dict], question: str) -> str:
        """
        General financial chat — not tied to a specific symbol.
        history: [{"sender": "user", "text": "..."}, {"sender": "ai", "text": "..."}]
        """
        # 1. Standardize Greeting Check
        # Added basic punctuation stripping to catch "Hello!" or "Hi."
        clean_q = question.strip().lower().translate(str.maketrans('', '', '?.!'))
        greetings = {"hi", "hello", "hey", "hii", "helo", "howdy", "sup", "yo"}
        
        if clean_q in greetings:
            return ("Hey! I'm FinEx, your modern AI financial analyst. "
                    "Ask me anything about stocks, company financials, or investing — I'm here to help. 📈")

        # 2. Build History String (Context)
        # We limit to the last 6-8 messages to prevent prompt bloat
        hist_context = ""
        if history:
            for m in history[-6:]:
                role = "User" if m.get("sender") == "user" else "FinEx"
                text = m.get("text", "").strip()
                if text:
                    hist_context += f"{role}: {text}\n"

        # 3. Construct the Prompt (Now including hist_context)
        prompt = f"""You are FinEx, a senior financial AI assistant. 
    You help users understand company financials, stock metrics, investing concepts, and market analysis.
    Answer clearly and concisely. If you don't have enough data, say so honestly.
    - Use precise financial terminology.
            - If possible, include examples, simple calculations, or step-by-step reasoning.
            - Use bullet points or tables for clarity.
            - If you don't have enough data, say so honestly and suggest what information would help.

    {hist_context}
    User: {question}
    FinEx:""".strip()

        # 4. Call LLM with Error Handling
        try:
            result = self._call(prompt).strip()
        except Exception as e:
            print(f"LLM Call Error: {e}")
            return "I'm sorry, I'm having trouble processing that right now. Please try again."

        # 5. Store in Memory
        # Note: Using a timestamp in the key is good for logs, 
        # but ensure your memory.store logic doesn't expect a static key for retrieval.
        ts = datetime.datetime.now(datetime.UTC).strftime('%H%M%S')
        self.memory.store(f"GLOBAL_CHAT_{ts}", result, ttl=1800)

        return result