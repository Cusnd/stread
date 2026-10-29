import { createContext, useContext } from "react";
import { defaultReaderRuntime } from "./reader-runtime.js";

const ReaderRuntimeContext = createContext(defaultReaderRuntime);
export const ReaderRuntimeProvider = ReaderRuntimeContext.Provider;
export const useReaderRuntime = () => useContext(ReaderRuntimeContext);
