import _ from 'underscore';

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
			'aws:package:finalize:mergeCustomProviderResources': this.modifyTemplate.bind(this),
		};
	}

	modifyTemplate() {
		const template = this.serverless.service.provider.compiledCloudFormationTemplate;

		this.modifyExecutionRole(template);
		this.modifyLambdaFunctionsAndDistributions(this.serverless.service.functions, template);
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

	modifyLambdaFunctionsAndDistributions(functions, template) {
		_.chain(functions)
			.pick(_.property('lambdaAtEdge')) // `pick` is used like `filter`, but for objects
			.each((fnDef, fnName) => {
				const { lambdaAtEdge } = fnDef;

				if (_.isArray(lambdaAtEdge)) {
					_.each(lambdaAtEdge, this.handleSingleFunctionAssociation.bind(this, template, fnDef, fnName));
				} else {
					this.handleSingleFunctionAssociation(template, fnDef, fnName, lambdaAtEdge);
				}
			});
	}

	handleSingleFunctionAssociation(template, fnDef, fnName, lambdaAtEdge) {
		const { distribution, pathPattern } = lambdaAtEdge;

		const fnLogicalName = this.provider.naming.getLambdaLogicalId(fnName);
		const outputName = this.provider.naming.getLambdaVersionOutputLogicalId(fnName);

		const fnProps = template.Resources[fnLogicalName].Properties;
		const evtType = lambdaAtEdge.eventType;
		const output = template.Outputs[outputName];
		const dist = template.Resources[distribution];

		let distConfig = null;
		let cacheBehavior = null;
		let fnAssociations = null;
		let versionLogicalID = null;


		if (!_.contains(VALID_EVENT_TYPES, evtType)) {
			throw new Error(`"${evtType}" is not a valid event type, must be one of: ${VALID_EVENT_TYPES.join(', ')}`);
		}

		if (!dist) {
			throw new Error(`Could not find resource with logical name ${distribution}`);
		}

		if (dist.Type !== 'AWS::CloudFront::Distribution') {
			throw new Error(`Resource with logical name ${distribution} is not type AWS::CloudFront::Distribution`);
		}

		versionLogicalID = (output ? output.Value.Ref : null);

		if (!versionLogicalID) {
			throw new Error(`Could not find output by name of ${outputName} or value from it to use version ARN`);
		}

		if (fnProps && fnProps.Environment && fnProps.Environment.Variables) {
			const numEnvVars = _.size(fnProps.Environment.Variables);
			this.serverless.cli.log(`Removing ${numEnvVars} environment variables from function ${fnLogicalName} because Lambda@Edge does not support environment variables`);

			delete fnProps.Environment.Variables;

			if (_.isEmpty(fnProps.Environment)) {
				delete fnProps.Environment;
			}
		}

		distConfig = dist.Properties.DistributionConfig;

		if (pathPattern) {
			cacheBehavior = _.findWhere(distConfig.CacheBehaviors, { PathPattern: pathPattern });

			if (!cacheBehavior) {
				throw new Error(`Could not find cache behavior in ${distribution} with path pattern ${pathPattern}`);
			}
		} else {
			cacheBehavior = distConfig.DefaultCacheBehavior;
		}

		fnAssociations = cacheBehavior.LambdaFunctionAssociations;

		if (!_.isArray(fnAssociations)) {
			fnAssociations = [];
			cacheBehavior.LambdaFunctionAssociations = [];
		}

		fnAssociations.push({
			EventType: evtType,
			LambdaFunctionARN: { Ref: versionLogicalID },
		});

		const confirmationLog = `Added "${evtType}" Lambda@Edge association for version "${versionLogicalID}" to distribution "${distribution}"`;
		if (pathPattern) {
			this.serverless.cli.log(`${confirmationLog} (path pattern: "${pathPattern}")`);
		} else {
			this.serverless.cli.log(`${confirmationLog}`);
		}
	}
}

export default Plugin;
