const defaultTriggerBehaviour = 'never';
const iconv = require('iconv-lite');

module.exports.templateTags = [
  {
    name: 'RegExpExtractor',
    displayName: 'RegExp from response',
    description: "reference values from other request's responses",
    args: [
      {
        displayName: 'Request',
        type: 'model',
        model: 'Request',
      },
      {
        displayName: 'Attribute',
        type: 'enum',
        defaultValue: "body",
        options: [
          {
            displayName: 'Request body',
            value: 'body',
          }
        ]
      },
      {
        type: 'string',
        displayName: 'RegExp',
        value: '',
      },
      {
        displayName: 'Trigger Behavior',
        help: 'Configure when to resend the dependent request',
        type: 'enum',
        defaultValue: defaultTriggerBehaviour,
        options: [
          {
            displayName: 'Never',
            description: 'never resend request',
            value: 'never',
          },
          {
            displayName: 'No History',
            description: 'resend when no responses present',
            value: 'no-history',
          },
          {
            displayName: 'When Expired',
            description: 'resend when existing response has expired',
            value: 'when-expired',
          },
          {
            displayName: 'Always',
            description: 'resend request when needed',
            value: 'always',
          },
        ],
      },
      {
        displayName: 'Max age (seconds)',
        help: 'The maximum age of a response to use before it expires',
        type: 'number',
        hide: args => {
          const triggerBehavior = (args[3] && args[3].value) || defaultTriggerBehaviour;
          return triggerBehavior !== 'when-expired';
        },
        defaultValue: 60,
      },
    ],

    async run(context, id, attribute, filter, resendBehavior, maxAgeSeconds) {
      filter = filter || '';
      resendBehavior = (resendBehavior || defaultTriggerBehaviour).toLowerCase();

      if (!id) {
        throw new Error('No request specified');
      }

      const request = await context.util.models.request.getById(id);
      if (!request) {
        throw new Error(`Could not find request ${id}`);
      }

      const environmentId = context.context.getEnvironmentId();
      let response = await context.util.models.response.getLatestForRequestId(id, environmentId);

      let shouldResend = false;
      switch (resendBehavior) {
        case 'no-history':
          shouldResend = !response;
          break;

        case 'when-expired':
          if (!response) {
            shouldResend = true;
          } else {
            const ageSeconds = (Date.now() - response.created) / 1000;
            shouldResend = ageSeconds > maxAgeSeconds;
          }
          break;

        case 'always':
          shouldResend = true;
          break;

        case 'never':
        default:
          shouldResend = false;
          break;

      }

      // Make sure we only send the request once per render so we don't have infinite recursion
      const requestChain = context.context.getExtraInfo('requestChain') || [];
      if (requestChain.some(id => id === request._id)) {
        console.log('[response tag] Preventing recursive render');
        shouldResend = false;
      }

      if (shouldResend && context.renderPurpose === 'send') {
        console.log('[response tag] Resending dependency');
        requestChain.push(request._id)
        response = await context.network.sendRequest(request, [
          { name: 'requestChain', value: requestChain }
        ]);
      }

      if (!response) {
        console.log('[response tag] No response found');
        throw new Error('No responses for request');
      }

      if (response.error) {
        console.log('[response tag] Response error ' + response.error);
        throw new Error('Failed to send dependent request ' + response.error);
      }

      if (!response.statusCode) {
        console.log('[response tag] Invalid status code ' + response.statusCode);
        throw new Error('No successful responses for request');
      }

      if (!filter) {
        throw new Error(`No filter specified`);
      }

      if (attribute != "body"){
        throw new Error(`Not implemented yet`);
      }
      const bodyBuffer = context.util.models.response.getBodyBuffer(response, '');
      const match = response.contentType && response.contentType.match(/charset=([\w-]+)/);
      const charset = match && match.length >= 2 ? match[1] : 'utf-8';

      let body;
      try {
        body = iconv.decode(bodyBuffer, charset);
      } catch (err) {
        body = bodyBuffer.toString();
        console.warn('[response] Failed to decode body', err);
      }

      try {
        let re = new RegExp(filter, "g");
        let result = re.exec(body)
        if (!result){
          throw new Error(`Wrong regexp: ${filter}`);
        }
        else if (typeof result.length === 0){
          throw new Error(`No matches`);
        }
        else if (result.length > 2) {
          throw new Error(`RegExp returns too many results: ${result.groups}`);
        }
        else if (result.length === 2) {
          return result[1]
        }
        else {
          return result[0]
        }
      }
      catch (e){
        throw new Error(`Wrong regexp: ${filter}, ${e}`);
      }
    },
  },
];
