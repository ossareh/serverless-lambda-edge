import { noop } from 'underscore';
import expect from 'expect.js';
import Plugin from '../index';

function stubServerless() {
	return {
		getProvider: () => ({}),
		cli: {
			log: noop,
			consoleLog: noop,
			printDot: noop,
		},
	};
}

describe('serverless-plugin-cloudfront-lambda-edge', () => {
	let plugin;

	beforeEach(() => {
		plugin = new Plugin(stubServerless(), {});
	});

	describe('TODO', () => {
		it('needs to be tested', () => {
			expect(1).to.eql(1);
		});
	});
});
