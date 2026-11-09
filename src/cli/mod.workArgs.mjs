import { defaultCommandAlternatives } from './mod.defaultCommand.mjs';
import { configuredProviders, findSessions } from './mod.resumeProviders.mjs';

const hasTranscript = (engine, path, env) => {
  const providers = configuredProviders(env).filter(provider => provider.name === engine);
  return findSessions(providers, new Map([[path, path]])).has(path);
};

export function workAgentArgs(engine, path, env = process.env) {
  const choices = defaultCommandAlternatives(engine, env);
  const usable = choices.find(args => !args.includes('--continue') || hasTranscript(engine, path, env));
  return usable ?? [];
}
