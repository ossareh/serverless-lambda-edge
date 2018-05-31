# Serverless Plugin: Support CloudFront Lambda@Edge

<!-- [![Build Status](https://travis-ci.org/silvermine/serverless-plugin-cloudfront-lambda-edge.png?branch=master)](https://travis-ci.org/silvermine/serverless-plugin-cloudfront-lambda-edge)
[![Coverage Status](https://coveralls.io/repos/github/silvermine/serverless-plugin-cloudfront-lambda-edge/badge.svg?branch=master)](https://coveralls.io/github/silvermine/serverless-plugin-cloudfront-lambda-edge?branch=master)
[![Dependency Status](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge.png)](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge)
[![Dev Dependency Status](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge/dev-status.png)](https://david-dm.org/silvermine/serverless-plugin-cloudfront-lambda-edge#info=devDependencies&view=table) -->

This is a hard fork of [serverless-plugin-cloudfront-lambda-edge](https://github.com/silvermine/serverless-plugin-cloudfront-lambda-edge).
We had some specific issues with the original version and as the original author is working on v2 thought it most
appropriate to fork this version, make the changes, and wait to see what comes of v2.

The notable difference between the original and this version, is that this version makes no attempt to configure or
control your CloudFront setup. As CloudFront changes can take a long time to apply it's trivial to, accidentally,
change a critical part of your infrastructure in a meaningful way using serverless, thus we've taken the position that
it's better to manage that not within serverless.

A good portion of this readme can be attributed to [Jeremy Thomerson](https://github.com/jthomerson) the author of the
base plugin from which this was crafted. Thanks Jeremy 👍🏻

## What does this plugin do?

This is a plugin for the Serverless framwork that adds support for configuring Lambda functions such that they're
compatible with Lambda@Edge.

The [`LambdaFunctionAssociations`][fnassoc] array in CloudFront needs a reference to the
Lambda function's _version_ (`AWS::Lambda::Version` resource), not just the function
itself. (The documentation for CloudFormation says "You must specify the ARN of a function
version; you can't specify a Lambda alias or $LATEST."). Serverless creates the version
automatically for you, but the logical ID for it is seemingly random. You need that
logical ID to use a `Ref` in your CloudFormation template for the function association.

This plugin handles that for you - it uses other features in Serverless to be able to programmatically determine the
function's logical ID and export that reference such that you can reference it in your CloudFront configuration. It
also strips environment variables from your function since Lambda@Edge does not allow those.

## How do I use it?

There are three steps:

### Install the Plugin as a Development Dependency

```bash
yarn add --dev serverless-lambda-edge
```

### Telling Serverless to Use the Plugin

Simply add this plugin to the list of plugins in your `serverless.yml` file:

```yml
plugins:
   - serverless-lambda-edge
```

### Configuring Functions to Associate With CloudFront Distributions

In your `serverless.yml` file, you will modify your function definitions to include a
`lambdaAtEdge` property. This property specifies that event type your function will fire on

*   **`eventType`** (required): a string, one of the four Lambda@Edge event types:
    *   viewer-request
    *   origin-request
    *   viewer-response
    *   origin-response

For example:

```yml
functions:
   directoryRootOriginRequestRewriter:
      name: '${self:custom.objectPrefix}-directory-root-origin-request-rewriter'
      handler: src/DirectoryRootOriginRequestRewriteHandler.handler
      memorySize: 128
      timeout: 1
      lambdaAtEdge:
         eventType: 'origin-request'
```

You can then reference the event type through the following export:

*   `directoryRootOriginRequestRewriterLambddaFunction:<stage>-ARN`
*   `directoryRootOriginRequestRewriterLambddaFunction:<stage>-EventType`

As above the ARN is versioned, so if you update your function you need to update your cloudformation also

## Example CloudFront Static Site Serverless Config

```yml
service:
  name: site-lambda-edge

plugins:
  - serverless-lambda-edge

provider:
  name: aws
  runtime: nodejs8.10
  memorySize: 256
  stage: ${opt:stage, 'development'}
  # Lambda@Edge must be in us-east-1
  region: us-east-1

functions:
  csp:
    handler: index.handler
    lambdaAtEdge:
      eventType: 'origin-response'
```

And here is an example function that would go with this Serverless template:

```js
"use strict";
exports.handler = (event, context, callback) => {
	//Get contents of response
	const response = event.Records[0].cf.response;
	const headers = response.headers;

	//Set new headers
	headers["strict-transport-security"] = [
		{ key: "Strict-Transport-Security", value: "max-age= 63072000; includeSubdomains; preload" }
	];
	headers["content-security-policy"] = [
		{
			key: "Content-Security-Policy",
			value: "default-src 'none'; img-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'"
		}
	];
	headers["x-content-type-options"] = [{ key: "X-Content-Type-Options", value: "nosniff" }];
	headers["x-frame-options"] = [{ key: "X-Frame-Options", value: "DENY" }];
	headers["x-xss-protection"] = [{ key: "X-XSS-Protection", value: "1; mode=block" }];
	headers["referrer-policy"] = [{ key: "Referrer-Policy", value: "same-origin" }];

	//Return modified response
	callback(null, response);
};
```

Finally here's an example of CloudFront configured by way of Cloudformation referenceing the functions:

```yml
# StackName: FamFiSiteCloudFront
# TODO: move this to us-east-1
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  SiteDistribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Enabled: 'true'
        Comment: My Fancy Site
        DefaultRootObject: index.html
        IPV6Enabled: true

        DefaultCacheBehavior:
          AllowedMethods:
            - GET
            - HEAD
            - OPTIONS
          DefaultTTL: 300
          ForwardedValues:
            QueryString: 'false'
            Cookies:
              Forward: none
          TargetOriginId: SiteS3Bucket
          ViewerProtocolPolicy: redirect-to-https

		# Note: `!Import` only works within the same region, if you're going across region you need to hardcode the URL
		LambdaFunctionAssociations:
            - LambdaFunctionARN: !Import 'CspLambdaFunction:production-ARN'
              EventType: !Import 'CspLambdaFunction:production-EventType'

        Origins:
          - Id: SiteS3Bucket
            DomainName: s3-hosted-website
            # Allows you to hide your s3 origin
            S3OriginConfig:
              OriginAccessIdentity: !Sub
                - origin-access-identity/cloudfront/${ID}
                - { ID: !Ref SiteDistributionAccessIdentity }


        PriceClass: PriceClass_100

        # Cert ARN is hardcoded because out cannot `!ImportValue` across regions, certs are stored in us-east-1
        ViewerCertificate:
			CloudFrontDefaultCertificate: true

  SiteDistributionAccessIdentity:
    Type: "AWS::CloudFront::CloudFrontOriginAccessIdentity"
    Properties:
      CloudFrontOriginAccessIdentityConfig:
        Comment: "Allows for hiding the s3 origin"
```

## License

This software is released under the MIT license. See [the license file](LICENSE) for more
details.

[fnassoc]: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-cloudfront-distribution-cachebehavior.html#cfn-cloudfront-distribution-cachebehavior-lambdafunctionassociations
