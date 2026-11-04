#!/usr/bin/env python3
"""
Script para baixar histórico diário (1D) de Cardano (ADA) dos últimos 2 anos,
salvar em CSV e calcular SMA de 20 períodos e RSI de 14 períodos.
Usa yfinance (Yahoo Finance) — fonte gratuita e estável para ADA-USD.
"""

import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta
import os

# Configurações
TICKER = "ADA-USD"
PERIOD_YEARS = 2
SMA_PERIOD = 20
RSI_PERIOD = 14
OUTPUT_CSV = "ADA_USD_diario_2anos_SMA_RSI.csv"

def calcular_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Calcula o Índice de Força Relativa (RSI) clássico."""
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)

    avg_gain = gain.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, min_periods=period, adjust=False).mean()

    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return rsi

def main():
    print(f"Baixando dados diários de {TICKER} dos últimos {PERIOD_YEARS} anos...")

    end_date = datetime.now()
    start_date = end_date - timedelta(days=PERIOD_YEARS * 365 + 30)  # margem extra

    # Download
    df = yf.download(
        TICKER,
        start=start_date.strftime("%Y-%m-%d"),
        end=end_date.strftime("%Y-%m-%d"),
        interval="1d",
        auto_adjust=True,  # ajusta por splits/dividends se houver
        progress=False,
    )

    if df.empty:
        raise RuntimeError("Nenhum dado retornado. Verifique o ticker ou a conexão.")

    # Limpeza básica
    df = df.dropna(how="all")
    df.index = pd.to_datetime(df.index)
    df = df.sort_index()

    # Garante colunas padrão (yfinance às vezes retorna MultiIndex)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    # Calcula indicadores
    df["SMA_20"] = df["Close"].rolling(window=SMA_PERIOD).mean()
    df["RSI_14"] = calcular_rsi(df["Close"], period=RSI_PERIOD)

    # Seleciona e renomeia colunas para clareza
    colunas = ["Open", "High", "Low", "Close", "Volume", "SMA_20", "RSI_14"]
    df_final = df[colunas].copy()
    df_final = df_final.round({
        "Open": 6, "High": 6, "Low": 6, "Close": 6,
        "Volume": 0, "SMA_20": 6, "RSI_14": 2
    })

    # Remove linhas iniciais sem SMA/RSI (NaN)
    df_final = df_final.dropna(subset=["SMA_20", "RSI_14"])

    # Salva CSV
    output_path = os.path.join(os.path.dirname(__file__) or ".", OUTPUT_CSV)
    df_final.to_csv(output_path, index_label="Date")
    print(f"Arquivo salvo: {output_path}")
    print(f"Período: {df_final.index.min().date()} → {df_final.index.max().date()}")
    print(f"Total de linhas: {len(df_final)}")
    print("\nÚltimas 5 linhas:")
    print(df_final.tail().to_string())

if __name__ == "__main__":
    main()
