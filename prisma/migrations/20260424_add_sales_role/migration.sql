-- Add SALES role to Role enum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SALES';
