-- Add SCRAP value to StockMoveType enum
ALTER TYPE "StockMoveType" ADD VALUE IF NOT EXISTS 'SCRAP';
