declare module "africastalking" {
  function AfricasTalking(options: { apiKey: string; username: string }): {
    SMS: {
      send(options: { to: string[]; message: string }): Promise<any>;
    };
    VOICE: any;
    AIRTIME: {
      send(options: { recipients: { phoneNumber: string; amount: string }[] }): Promise<any>;
    };
  };
  export = AfricasTalking;
}
