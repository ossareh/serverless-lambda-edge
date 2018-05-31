'use strict';

const _ = require('underscore');

const VALID_EVENT_TYPES = [
	'viewer-request',
	'origin-request',
	'viewer-response',
	'origin-response',
];

class Plugin {
	constructor(serverless, opts) {
		this.serverless = serverless;
		this.provider = serverless ? serverless.getProvider('aws') : null;
		this.opts = opts;

		if (!this.provider) {
			throw new Error('This plugin must be used with AWS');
		}

		this.hooks = {
			'after:aws:package:finalize:mergeCustomProviderResources': this.modifyTemplate.bind(this),
		};
	}

	modifyTemplate() {
		const template = this.serverless.service.provider.compiledCloudFormationTemplate;

		this.modifyExecutionRole(template);
		this.modifyLambdaFunctions(this.serverless.service.functions, template);
	}

	modifyExecutionRole(template) {
		let assumeRoleUpdated = false;

		if (!template.Resources || !template.Resources.IamRoleLambdaExecution) {
			this.serverless.cli.log('WARNING: no IAM role for Lambda execution found - can not modify assume role policy');
			return;
		}

		_.each(template.Resources.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument.Statement, (stmt) => {
			const svc = stmt.Principal.Service;

			if (stmt.Principal && svc && _.contains(svc, 'lambda.amazonaws.com') && !_.contains(svc, 'edgelambda.amazonaws.com')) {
				svc.push('edgelambda.amazonaws.com');
				assumeRoleUpdated = true;
				this.serverless.cli.log('Updated Lambda assume role policy to allow Lambda@Edge to assume the role');
			}
		});

		if (!assumeRoleUpdated) {
			this.serverless.cli.log('WARNING: was unable to update the Lambda assume role policy to allow Lambda@Edge to assume the role');
		}

		// Serverless creates a LogGroup by a specific name, and grants logs:CreateLogStream
		// and logs:PutLogEvents permissions to the function. However, on a replicated
		// function, AWS will name the log groups differently, so the Serverless-created
		// permissions will not work. Thus, we must give the function permission to create
		// log groups and streams, as well as put log events.
		//
		// Since we don't have control over the naming of the log group, we let this
		// function have permission to create and use a log group by any name.
		// See http://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/iam-identity-based-access-control-cwl.html
		template.Resources.IamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement.push({
			Effect: 'Allow',
			Action: [
				'logs:CreateLogGroup',
				'logs:CreateLogStream',
				'logs:PutLogEvents',
				'logs:DescribeLogStreams',
			],
			Resource: 'arn:aws:logs:*:*:*',
		});
	}

	modifyLambdaFunctions(functions, template) {
		_.chain(functions)
			.pick(_.property('lambdaAtEdge')) // `pick` is used like `filter`, but for objects
			.each((fnDef, fnName) => {
				const { lambdaAtEdge } = fnDef;

				if (_.isArray(lambdaAtEdge)) {
					_.each(lambdaAtEdge, this.handleFunctionChanges.bind(this, template, fnName));
				} else {
					this.handleFunctionChanges(template, fnName, lambdaAtEdge);
				}
			});
	}

	handleFunctionChanges(template, fnName, lambdaAtEdge) {
		const { eventType } = lambdaAtEdge;

		if (!_.contains(VALID_EVENT_TYPES, eventType)) {
			throw new Error(`"${eventType}" is not a valid event type, must be one of: ${VALID_EVENT_TYPES.join(', ')}`);
		}

		const fnLogicalName = this.provider.naming.getLambdaLogicalId(fnName);
		const outputName = this.provider.naming.getLambdaVersionOutputLogicalId(fnName);

		const fnProps = template.Resources[fnLogicalName].Properties;
		const outputs = template.Outputs;

		outputs[`${fnLogicalName}EventType`] = {
			Description: 'The event type for this function',
			Value: eventType,
			Export: {
				Name: `${fnLogicalName}:${this.provider.getStage()}-EventType`,
			},
		};

		const output = outputs[outputName];

		if (!output) {
			throw new Error(`Could not find output by name of: ${outputName}`);
		}

		output.Export = {
			Name: `${fnLogicalName}:${this.provider.getStage()}-ARN`,
		};

		if (fnProps && fnProps.Environment && fnProps.Environment.Variables) {
			const numEnvVars = _.size(fnProps.Environment.Variables);
			if (numEnvVars > 0) {
				this.serverless.cli.log(`Removing ${numEnvVars} environment variables from function ${fnLogicalName} because Lambda@Edge does not support environment variables`);
				delete fnProps.Environment.Variables;
				if (_.isEmpty(fnProps.Environment)) {
					delete fnProps.Environment;
				}
			}
		}

		this.serverless.cli.log(`Added "${eventType}" Lambda@Edge association for version: ${output.Value}`);
		this.serverless.cli.log(`Reminder: if you reference this ARN anywhere you need to reference the new value now: ${output.Value}`);
	}
}

module.exports = Plugin;
