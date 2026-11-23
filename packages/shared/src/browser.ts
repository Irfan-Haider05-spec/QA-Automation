/**
 * Import this first in browser apps served with a Content-Security-Policy that has no
 * 'unsafe-eval' (the dashboard's does not). Zod probes `new Function("")` to decide whether
 * it may compile validators, and browsers report that probe as a CSP violation on every
 * page. Validation results are the same without compilation, so compilation is turned off
 * before any schema is created (schemas read this setting when they are constructed).
 */
import { config } from "zod";

config({ jitless: true });
