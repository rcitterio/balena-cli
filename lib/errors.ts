/*
Copyright 2016-2020 Balena

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { stripIndent } from 'common-tags';
import * as _ from 'lodash';
import * as os from 'os';
import { TypedError } from 'typed-error';

export class ExpectedError extends TypedError {}

export class NotLoggedInError extends ExpectedError {}

export class InsufficientPrivilegesError extends ExpectedError {}

/**
 * instanceOf is a more reliable implemention of the plain `instanceof`
 * typescript operator, for use with TypedError errors when the error
 * classes may be defined in external packages/dependencies.
 * Sample usage:
 *    instanceOf(err, BalenaApplicationNotFound)
 *
 * A plain Typescript `instanceof` test may fail if `npm install` results
 * in multiple instances of a package, for example multiple versions of
 * `balena-errors`:
 *     $ find node_modules -type d -name balena-errors
 *     node_modules/balena-errors
 *     node_modules/balena-sdk/node_modules/balena-errors
 *
 * In these cases, `instanceof` produces a false negative when comparing objects
 * and classes of the different package versions, but the `err.name` test still
 * succeeds.
 *
 * @param err Error object, for example in a `catch(err)` block
 * @param klass TypedError subclass, e.g. BalenaApplicationNotFound. The type
 * is annotated as 'any' for the same reason of multiple package installations
 * mentioned above.
 */
export function instanceOf(err: any, klass: any): boolean {
	if (err instanceof klass) {
		return true;
	}
	const name: string | undefined = err.name || err.constructor?.name;
	return name != null && name === klass.name;
}

function hasCode(error: any): error is Error & { code: string } {
	return error.code != null;
}

function treatFailedBindingAsMissingModule(error: any): void {
	if (error.message.startsWith('Could not locate the bindings file.')) {
		error.code = 'MODULE_NOT_FOUND';
	}
}

function interpret(error: Error): string {
	treatFailedBindingAsMissingModule(error);

	if (hasCode(error)) {
		const errorCodeHandler = messages[error.code];
		const message = errorCodeHandler && errorCodeHandler(error);

		if (message) {
			return message;
		}

		if (!_.isEmpty(error.message)) {
			return `${error.code}: ${error.message}`;
		}
	}

	return error.message;
}

const messages: {
	[key: string]: (error: Error & { path?: string }) => string;
} = {
	EISDIR: error => `File is a directory: ${error.path}`,

	ENOENT: error => `No such file or directory: ${error.path}`,

	ENOGIT: () => stripIndent`
		Git is not installed on this system.
		Head over to http://git-scm.com to install it and run this command again.`,

	EPERM: () => stripIndent`
		You don't have sufficient privileges to run this operation.
		${
			os.platform() === 'win32'
				? 'Run a new Command Prompt as administrator and try running this command again.'
				: 'Try running this command again prefixing it with `sudo`.'
		}

		If this is not the case, and you're trying to burn an SDCard, check that the write lock is not set.`,

	EACCES: e => messages.EPERM(e),

	ETIMEDOUT: () =>
		'Oops something went wrong, please check your connection and try again.',

	MODULE_NOT_FOUND: () => stripIndent`
		Part of the CLI could not be loaded. This typically means your CLI install is in a broken state.
		${
			os.arch() === 'x64'
				? 'You can normally fix this by uninstalling and reinstalling the CLI.'
				: stripIndent`
				You're using an unsupported architecture (${os.arch()}), so this is typically caused by missing native modules.
				Reinstalling may help, but pay attention to errors in native module build steps en route.
			`
		}
	`,

	BalenaExpiredToken: () => stripIndent`
		Looks like your session token is expired.
		Please try logging in again with:
			$ balena login`,
};

export async function handleError(error: any) {
	const { printErrorMessage } = await import('./utils/patterns');

	process.exitCode =
		error.exitCode === 0
			? 0
			: parseInt(error.exitCode, 10) || process.exitCode || 1;

	if (!(error instanceof Error)) {
		printErrorMessage(String(error));
		return;
	}

	const message = [interpret(error)];

	if (process.env.DEBUG && error.stack) {
		message.push(error.stack);
	}
	printErrorMessage(message.join('\n'));

	const expectedErrorREs = [
		/^BalenaApplicationNotFound:/, // balena-sdk
		/^BalenaDeviceNotFound:/, // balena-sdk
		/^Missing \w+$/, // Capitano's command line parsing error
		/^Unexpected arguments?:/, // oclif's command line parsing error
	];

	if (
		error instanceof ExpectedError ||
		expectedErrorREs.some(re => re.test(message[0]))
	) {
		return;
	}

	// Report "unexpected" errors via Sentry.io
	const Sentry = await import('@sentry/node');
	Sentry.captureException(error);
	await Sentry.close(1000);
	// Unhandled/unexpected error: ensure that the process terminates.
	// The exit error code was set above through `process.exitCode`.
	process.exit();
}
