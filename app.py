import os
from contextlib import asynccontextmanager
from typing import Optional
from dotenv import load_dotenv

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from dataagent.dataagent import DataAgent
from memory.memorylayer import MemoryLayer
from matrixagent.MatrixCompAGENT import MetricsAgent
from scoreengine.scoreEngine import score_company
from llmagent.LLMAgentComp import LLMAgent

load_dotenv(override=True)

# Global instances that will be initialized during startup
instances = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize components
    mongo_uri = os.getenv("mongo_uri", "mongodb://localhost:27017")
    mongo_db_name = os.getenv("mongo_db_name", "finagent")
    alpha_vantage_key = os.getenv("Alpha_vantage_API-Key", "dummy_alpha_vantage_key")
    gemini_api_key = os.getenv("gemini_API-Key", "dummy_gemini_key")

    if not all([mongo_uri, mongo_db_name, alpha_vantage_key, gemini_api_key]):
        print("WARNING: Missing environment variables! Check your .env file.")

    memory = MemoryLayer(mongo_uri, mongo_db_name)
    data_agent = DataAgent(api_key=alpha_vantage_key, memory=memory)
    matrix_agent = MetricsAgent(memory=memory)
    llm = LLMAgent(api_key=gemini_api_key, memory=memory)

    instances["memory"] = memory
    instances["data_agent"] = data_agent
    instances["matrix_agent"] = matrix_agent
    instances["llm"] = llm

    yield
    # Cleanup (if any)
    instances.clear()

app = FastAPI(lifespan=lifespan, title="FINTECH API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AnalyzeRequest(BaseModel):
    symbol: str

class ChatRequest(BaseModel):
    symbol: str
    question: str


@app.post("/api/analyze")
async def analyze_company(req: AnalyzeRequest):
    symbol = req.symbol.upper().strip()
    
    # 0. Reload env vars locally to prevent any Uvicorn caching issues
    import dotenv
    env_vars = dotenv.dotenv_values(".env")
    
    alpha_key = (env_vars.get("Alpha_vantage_API-Key") or env_vars.get("ALPHA_VANTAGE_API_KEY") or "").strip().strip("\"'")
    gemini_key = (env_vars.get("gemini_API-Key") or env_vars.get("GEMINI_API_KEY") or "").strip().strip("\"'")
    
    # Validate the API Keys format
    if "YOUR_GEMINI_KEY_HERE" in gemini_key:
        raise HTTPException(status_code=500, detail="Error: You haven't pasted a real key yet! Please replace the words 'YOUR_GEMINI_KEY_HERE' in your .env file with your actual key from Google.")

    if not gemini_key or not gemini_key.startswith("AIza"):
        raise HTTPException(status_code=500, detail="Gemini API Key Error: Please make sure your .env file contains a valid gemini_API-Key (they start with 'AIza...'). Make sure it does not have extra quotes.")
        
    memory = instances["memory"]
    # Instantiate agents transparently per request to ensure fresh keys are used!
    data_agent = DataAgent(api_key=alpha_key, memory=memory)
    matrix_agent = MetricsAgent(memory=memory)
    llm = LLMAgent(api_key=gemini_key, memory=memory)
    
    # Auto-map common names to valid stock tickers to make it user-friendly
    name_map = {
        "GOOGLE": "GOOGL",
        "ALPHABET": "GOOGL",
        "APPLE": "AAPL",
        "MICROSOFT": "MSFT",
        "TESLA": "TSLA",
        "AMAZON": "AMZN",
        "META": "META",
        "FACEBOOK": "META",
        "NVIDIA": "NVDA"
    }
    if symbol in name_map:
        symbol = name_map[symbol]

    try:
        # 1. Fetch data if missing in memory
        if not memory.check_key(f"{symbol}_OVERVIEW"):
            memory.store(f"{symbol}_OVERVIEW", data_agent.fetch_company_overview(symbol))
        if not memory.check_key(f"{symbol}_INCOME"):
            memory.store(f"{symbol}_INCOME", data_agent.fetch_income_statement(symbol))
        if not memory.check_key(f"{symbol}_BALANCE"):
            memory.store(f"{symbol}_BALANCE", data_agent.fetch_balance_sheet(symbol))
        if not memory.check_key(f"{symbol}_CASHFLOW"):
            memory.store(f"{symbol}_CASHFLOW", data_agent.fetch_cash_flow(symbol))

        # 2. Compute Metrics
        metrics = matrix_agent.compute_metrics(symbol)

        # 3. Score
        score = score_company(symbol, memory)

        # 4. LLM Agents
        verdict = llm.verdict(symbol)
        recommendation = llm.recommend(symbol)
        
        # 5. Extract raw data limited to 4 records for UI statements
        raw_inc = memory.retrieve(f"{symbol}_INCOME") or []
        raw_bal = memory.retrieve(f"{symbol}_BALANCE") or []
        raw_csh = memory.retrieve(f"{symbol}_CASHFLOW") or []

        return {
            "symbol": symbol,
            "metrics": metrics,
            "score": {
                "overall_score": score.overall_score,
                "grade": score.grade,
                "descriptor": score.descriptor,
                "categories": score.categories,
                "flags": score.flags,
            },
            "ai": {
                "verdict": verdict,
                "recommendation": recommendation
            },
            "raw_data": {
                "income": raw_inc[:4] if isinstance(raw_inc, list) else [],
                "balance": raw_bal[:4] if isinstance(raw_bal, list) else [],
                "cashflow": raw_csh[:4] if isinstance(raw_csh, list) else []
            }
        }
    except Exception as e:
        print(f"Error analyzing {symbol}: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat")
async def chat(req: ChatRequest):
    symbol = req.symbol.upper().strip()
    
    import dotenv
    env_vars = dotenv.dotenv_values(".env")
    gemini_key = (env_vars.get("gemini_API-Key") or env_vars.get("GEMINI_API_KEY") or "").strip().strip("\"'")
    
    if not gemini_key or not gemini_key.startswith("AIza"):
        raise HTTPException(status_code=500, detail="Gemini API Key Error: Please make sure your .env file contains a valid gemini_API-Key (they start with 'AIza...').")
        
    memory = instances["memory"]
    llm = LLMAgent(api_key=gemini_key, memory=memory)
    
    try:
        response = llm.chat(symbol, req.question)
        return {"response": response}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class GlobalChatRequest(BaseModel):
    history: list = []
    question: str

@app.post("/api/global_chat")
async def global_chat(req: GlobalChatRequest):
    import dotenv
    env_vars = dotenv.dotenv_values(".env")
    gemini_key = (env_vars.get("gemini_API-Key") or env_vars.get("GEMINI_API_KEY") or "").strip().strip("\"'")
    if not gemini_key :
        print("wrong")
        raise HTTPException(status_code=500, detail="Gemini API Key Error.")
    
    memory = instances["memory"]
    llm = LLMAgent(api_key=gemini_key, memory=memory)
    print(req.question)
    print(llm)
    try:
        
        res = llm.global_chat(req.history, req.question)
        
        return {"response": res}
    except Exception as e:
        
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/extract_document")
async def extract_document(file: UploadFile = File(...)):
    import dotenv
    env_vars = dotenv.dotenv_values(".env")
    gemini_key = (env_vars.get("gemini_API-Key") or env_vars.get("GEMINI_API_KEY") or "").strip().strip("\"'")
    if not gemini_key or not gemini_key.startswith("AIza"):
        raise HTTPException(status_code=500, detail="Gemini API Key Error.")
        
    memory = instances["memory"]
    llm = LLMAgent(api_key=gemini_key, memory=memory)
    
    try:
        contents = await file.read()
        mime_type = file.content_type or "application/octet-stream"
        res = llm.analyze_document(contents, mime_type)
        return {"filename": file.filename, "extracted": res}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

# Mount static folder for frontend
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root():
    return FileResponse("static/index.html")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
